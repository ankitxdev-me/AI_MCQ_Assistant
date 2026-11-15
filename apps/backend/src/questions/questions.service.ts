import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database.service';
import { WebSearchService } from '../common/web-search.service';
import { ConfigService } from '../config/config.service';
import { GeminiProvider } from '../providers/gemini.provider';
import { SessionsService } from '../sessions/sessions.service';
import { EventsGateway } from '../events/events.gateway';
import {
  SolveQuestionPayload,
  SolveQuestionResponse,
  ExtractedQuestion,
  AIAnswerResult,
  PracticeSession,
  QuestionFeedbackPayload,
  TopicKnowledgeItem,
  CustomKnowledgeItem,
} from '@ai-mcq/shared-types';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly configService: ConfigService,
    private readonly geminiProvider: GeminiProvider,
    private readonly sessionsService: SessionsService,
    private readonly eventsGateway: EventsGateway,
    private readonly webSearchService: WebSearchService,
  ) {}

  async extractQuestions(
    sessionId: string,
    questions: ExtractedQuestion[],
  ): Promise<{ recorded: number; session: any }> {
    if (!sessionId) {
      throw new BadRequestException('Session ID is required for recording questions');
    }

    const session = this.sessionsService.recordExtractedQuestions(sessionId, questions);
    return {
      recorded: questions.length,
      session,
    };
  }

  async solveQuestion(payload: SolveQuestionPayload): Promise<SolveQuestionResponse> {
    const { sessionId, question, options, questionFingerprint, forceFresh } = payload;

    // Check if session exists and is active
    let session: PracticeSession;
    try {
      session = this.sessionsService.getSession(sessionId);
    } catch {
      this.logger.log(`Session ${sessionId} not found. Auto-creating session.`);
      session = this.sessionsService.createSession('http://127.0.0.1:3000', 'Auto Practice Session');
    }

    if (session.status === 'PAUSED') {
      throw new BadRequestException('Session is paused. Resume the session to continue solving.');
    }
    if (session.status === 'STOPPED') {
      throw new BadRequestException('Session is stopped.');
    }

    // 1. Duplicate & Cache Check
    if (!forceFresh) {
      const existingInSession = session.questions.find(
        (q) => q.fingerprint === questionFingerprint && q.aiAnswer,
      );
      if (existingInSession && existingInSession.aiAnswer) {
        this.logger.log(`Serving cached answer for fingerprint ${questionFingerprint} from session`);
        return {
          success: true,
          questionId: existingInSession.id || uuidv4(),
          answer: existingInSession.aiAnswer,
          cached: true,
          timestamp: new Date().toISOString(),
        };
      }

      // Check global cache table
      const cachedRow = this.db.queryOne<{ response_json: string }>(
        `SELECT response_json FROM cache WHERE fingerprint = ?`,
        [questionFingerprint],
      );
      if (cachedRow?.response_json) {
        try {
          const cachedAnswer: AIAnswerResult = JSON.parse(cachedRow.response_json);
          this.logger.log(`Serving answer for fingerprint ${questionFingerprint} from cache table`);
          this.sessionsService.updateQuestionAnswer(sessionId, questionFingerprint, cachedAnswer);
          return {
            success: true,
            questionId: uuidv4(),
            answer: cachedAnswer,
            cached: true,
            timestamp: new Date().toISOString(),
          };
        } catch (e) {
          // ignore corrupted cache
        }
      }

      // Check topic_knowledge ground truth by question text
      const cleanQ = question.trim();
      const verifiedRow = this.db.queryOne<{ correct_option_id: string; correct_option_text: string }>(
        `SELECT correct_option_id, correct_option_text FROM topic_knowledge WHERE question_text = ? OR question_fingerprint = ? ORDER BY was_incorrect_first DESC, created_at DESC LIMIT 1`,
        [cleanQ, questionFingerprint],
      );

      if (verifiedRow?.correct_option_text) {
        const normTarget = verifiedRow.correct_option_text.trim().toLowerCase();
        const matchedOpt = options.find((o) => {
          const norm = o.text.trim().toLowerCase();
          return (
            norm === normTarget ||
            (normTarget.length > 2 && (norm.includes(normTarget) || normTarget.includes(norm)))
          );
        });

        if (matchedOpt) {
          const verifiedAnswer: AIAnswerResult = {
            selected_option_id: matchedOpt.id,
            answer_text: matchedOpt.text,
            explanation: `Verified correct ground truth from previously recorded portal assessment.`,
            confidence: 1.0,
            needs_review: false,
          };
          this.logger.log(
            `Serving verified ground truth for question: "${cleanQ.slice(0, 50)}..." -> Option ${matchedOpt.id} (${matchedOpt.text})`,
          );
          this.sessionsService.updateQuestionAnswer(session.id, questionFingerprint, verifiedAnswer);
          return {
            success: true,
            questionId: uuidv4(),
            answer: verifiedAnswer,
            cached: true,
            timestamp: new Date().toISOString(),
          };
        }
      }
    }

    // 2. Fetch AI credentials & topic knowledge
    const apiKey = this.configService.getActiveApiKey();
    if (!apiKey) {
      throw new BadRequestException(
        'AI Provider is not configured. Please configure your Gemini API Key in the extension settings.',
      );
    }
    const model = this.configService.getActiveModel();

    // Determine topic and retrieve verified facts from previous questions
    const topic = this.extractTopic(question, session.pageTitle);
    const topicKnowledge = this.getTopicKnowledge(topic);
    if (topicKnowledge.length > 0) {
      this.logger.log(`Applying ${topicKnowledge.length} verified topic facts for topic: "${topic}"`);
    }

    // Retrieve custom user-provided notes/knowledge
    const customKnowledgeList = this.getCustomKnowledge(topic);
    const customKnowledgeText = customKnowledgeList.map((k) => `[Topic: ${k.topic}]\n${k.content}`).join('\n\n');
    if (customKnowledgeText) {
      this.logger.log(`Applying user-provided custom knowledge (${customKnowledgeList.length} active notes)`);
    }

    // Retrieve Web / Browser Search Evidence only if explicitly enabled (disabled by default for instant speed)
    let webSearchEvidence = payload.webSearchEvidence || [];
    if ((payload as any).enableWebSearch && webSearchEvidence.length === 0) {
      try {
        webSearchEvidence = await this.webSearchService.search(question, options);
      } catch (err: any) {
        this.logger.warn(`Web search error: ${err.message}`);
        webSearchEvidence = [];
      }
    }

    // 3. Mark question as PROCESSING
    this.db.run(
      `UPDATE questions SET status = 'PROCESSING' WHERE session_id = ? AND fingerprint = ?`,
      [session.id, questionFingerprint],
    );

    try {
      this.logger.log(
        `Sending question (fingerprint: ${questionFingerprint}) to Gemini model: ${model} [Topic: ${topic}] [WebEvidence: ${webSearchEvidence?.length || 0} snippets]`,
      );

      const aiAnswer = await this.geminiProvider.generateAnswer(
        question,
        options,
        {
          isMultipleChoiceMultipleAnswer: payload.isMultipleChoiceMultipleAnswer,
          isOrderingQuestion: payload.isOrderingQuestion,
          questionType: payload.questionType,
        },
        apiKey,
        model,
        topicKnowledge,
        customKnowledgeText,
        webSearchEvidence,
      );

      // Save to cache table
      this.db.run(
        `INSERT OR REPLACE INTO cache (fingerprint, response_json, created_at) VALUES (?, ?, ?)`,
        [questionFingerprint, JSON.stringify(aiAnswer), new Date().toISOString()],
      );

      // Update question and session metrics
      this.sessionsService.updateQuestionAnswer(session.id, questionFingerprint, aiAnswer);

      const questionRow = this.db.queryOne<any>(
        `SELECT id FROM questions WHERE session_id = ? AND fingerprint = ?`,
        [session.id, questionFingerprint],
      );

      const questionId = questionRow?.id || uuidv4();

      // Emit event
      this.eventsGateway.emitQuestionSolved({
        sessionId,
        questionId,
        questionFingerprint,
        aiAnswer,
      });

      return {
        success: true,
        questionId,
        answer: aiAnswer,
        cached: false,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      this.logger.error(`Failed to solve question: ${err.message}`);
      this.db.run(
        `UPDATE questions SET status = 'FAILED' WHERE session_id = ? AND fingerprint = ?`,
        [sessionId, questionFingerprint],
      );
      throw new BadRequestException(`AI Processing error: ${err.message}`);
    }
  }

  getQuestionById(id: string) {
    const question = this.db.queryOne<any>(`SELECT * FROM questions WHERE id = ?`, [id]);
    if (!question) {
      throw new NotFoundException(`Question ${id} not found`);
    }

    let options = [];
    try {
      options = JSON.parse(question.options_json);
    } catch (e) {
      options = [];
    }

    let aiAnswer = null;
    if (question.ai_answer_json) {
      try {
        aiAnswer = JSON.parse(question.ai_answer_json);
      } catch (e) {
        aiAnswer = null;
      }
    }

    return {
      ...question,
      options,
      aiAnswer,
    };
  }

  recordQuestionFeedback(payload: QuestionFeedbackPayload) {
    const {
      sessionId,
      questionFingerprint,
      questionText,
      selectedOptionId,
      selectedOptionText,
      isCorrect,
      actualCorrectOptionId,
      actualCorrectOptionText,
    } = payload;

    const topic = payload.topic || this.extractTopic(questionText);
    const now = new Date().toISOString();
    const id = uuidv4();

    const finalCorrectId = isCorrect ? selectedOptionId : (actualCorrectOptionId || selectedOptionId);
    const finalCorrectText = isCorrect
      ? (selectedOptionText || '')
      : (actualCorrectOptionText || selectedOptionText || '');

    // Record in topic_knowledge
    this.db.run(
      `INSERT INTO topic_knowledge (
        id, topic, question_fingerprint, question_text, correct_option_id,
        correct_option_text, was_incorrect_first, wrong_option_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        topic,
        questionFingerprint,
        questionText,
        finalCorrectId,
        finalCorrectText,
        isCorrect ? 0 : 1,
        isCorrect ? null : (selectedOptionText || null),
        now,
      ],
    );

    // If actual correct answer was verified, save ground truth into cache table
    if (finalCorrectText) {
      const groundTruthAnswer: AIAnswerResult = {
        selected_option_id: finalCorrectId,
        answer_text: finalCorrectText,
        explanation: isCorrect
          ? 'Verified correct option from assessment submission.'
          : `Verified portal answer (previously selected: ${selectedOptionText || 'N/A'}).`,
        confidence: 1.0,
        needs_review: false,
      };

      this.db.run(
        `INSERT OR REPLACE INTO cache (fingerprint, response_json, created_at) VALUES (?, ?, ?)`,
        [questionFingerprint, JSON.stringify(groundTruthAnswer), now],
      );
    }

    this.logger.log(`Recorded post-submission feedback for topic "${topic}": correct=${isCorrect}`);
    return { success: true, topic, recorded: true };
  }

  getTopicKnowledge(topic: string, limit: number = 8): TopicKnowledgeItem[] {
    const rows = this.db.query<any>(
      `SELECT * FROM topic_knowledge WHERE topic = ? ORDER BY created_at DESC LIMIT ?`,
      [topic, limit],
    );

    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      questionFingerprint: r.question_fingerprint,
      questionText: r.question_text,
      correctOptionId: r.correct_option_id,
      correctOptionText: r.correct_option_text,
      wasIncorrectFirst: Boolean(r.was_incorrect_first),
      wrongOptionText: r.wrong_option_text,
      createdAt: r.created_at,
    }));
  }

  saveCustomKnowledge(topic: string, content: string): CustomKnowledgeItem {
    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const safeTopic = topic && topic.trim().length > 0 ? topic.trim() : 'General';
    this.db.run(
      `INSERT INTO custom_knowledge (id, topic, content, is_active, created_at) VALUES (?, ?, ?, 1, ?)`,
      [id, safeTopic, content.trim(), createdAt],
    );
    this.logger.log(`Saved custom knowledge note [ID: ${id}, Topic: ${safeTopic}]`);
    return {
      id,
      topic: safeTopic,
      content: content.trim(),
      isActive: true,
      createdAt,
    };
  }

  getCustomKnowledge(topic?: string): CustomKnowledgeItem[] {
    // Return all active notes so user-provided context is always injected for Gemini
    const rows = this.db.query<any>(
      `SELECT * FROM custom_knowledge WHERE is_active = 1 ORDER BY created_at DESC`,
    );

    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      content: r.content,
      isActive: Boolean(r.is_active),
      createdAt: r.created_at,
    }));
  }

  deleteCustomKnowledge(id: string): { success: boolean } {
    this.db.run(`DELETE FROM custom_knowledge WHERE id = ?`, [id]);
    this.logger.log(`Deleted custom knowledge note [ID: ${id}]`);
    return { success: true };
  }

  extractTopic(questionText: string, pageTitle?: string): string {
    const text = (questionText + ' ' + (pageTitle || '')).toLowerCase();

    // 1. Logical Reasoning: Seating Arrangements
    if (
      text.includes('sitting') ||
      text.includes('seated') ||
      text.includes('circular table') ||
      text.includes('round table') ||
      text.includes('facing the centre') ||
      text.includes('facing the center') ||
      text.includes('facing center') ||
      text.includes('facing centre') ||
      text.includes('facing north') ||
      text.includes('facing south') ||
      text.includes('in a row') ||
      text.includes('on a bench') ||
      text.includes('immediate left') ||
      text.includes('immediate right') ||
      text.includes('third to the left') ||
      text.includes('second to the left') ||
      text.includes('second to the right') ||
      text.includes('third to the right')
    ) {
      return 'Logical Reasoning: Seating Arrangements';
    }

    // 2. Logical Reasoning: Blood Relations
    if (
      text.includes('father') ||
      text.includes('mother') ||
      text.includes('sister') ||
      text.includes('brother') ||
      text.includes('daughter') ||
      text.includes('son') ||
      text.includes('paternal') ||
      text.includes('maternal') ||
      text.includes('nephew') ||
      text.includes('niece') ||
      text.includes('uncle') ||
      text.includes('aunt')
    ) {
      return 'Logical Reasoning: Blood Relations';
    }

    // 3. Logical Reasoning: Direction Sense
    if (
      text.includes('towards north') ||
      text.includes('towards south') ||
      text.includes('towards east') ||
      text.includes('towards west') ||
      text.includes('turns left') ||
      text.includes('turns right') ||
      text.includes('starting point')
    ) {
      return 'Logical Reasoning: Direction Sense';
    }

    // 4. Quantitative Aptitude
    if (
      text.includes('speed') ||
      text.includes('train') ||
      text.includes('ratio') ||
      text.includes('percentage') ||
      text.includes('profit') ||
      text.includes('loss') ||
      text.includes('simple interest') ||
      text.includes('compound interest')
    ) {
      return 'Quantitative Aptitude';
    }

    if (text.includes('stream') || text.includes('pipe') || text.includes('buffer'))
      return 'Node.js Streams & Buffers';
    if (
      text.includes('dns') ||
      text.includes('http') ||
      text.includes('tcp') ||
      text.includes('ip') ||
      text.includes('network') ||
      text.includes('protocol')
    )
      return 'Networking & Web Protocols';
    if (
      text.includes('stack') ||
      text.includes('queue') ||
      text.includes('tree') ||
      text.includes('graph') ||
      text.includes('array') ||
      text.includes('linked list')
    )
      return 'Data Structures & Algorithms';
    if (text.includes('python') || text.includes('def ') || text.includes('lambda'))
      return 'Python Programming';
    if (text.includes('react') || text.includes('hook') || text.includes('state') || text.includes('component'))
      return 'React Framework';
    if (text.includes('sql') || text.includes('table') || text.includes('database') || text.includes('query'))
      return 'Databases & SQL';
    if (pageTitle && pageTitle.length > 5 && !pageTitle.toLowerCase().includes('job market'))
      return pageTitle.trim();
    return 'General Computer Science';
  }
}

