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
import { createHash } from 'crypto';

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
    const { question, options, questionFingerprint, forceFresh } = payload;

    // Reuse the caller's session, or open one for this page when none was supplied
    // (the per-tab Auto-Loop starts without a session).
    let session: PracticeSession | null = null;
    if (payload.sessionId) {
      try {
        session = this.sessionsService.getSession(payload.sessionId);
      } catch {
        this.logger.log(`Session ${payload.sessionId} not found. Auto-creating session.`);
      }
    }
    if (!session) {
      session = this.sessionsService.createSession(
        payload.pageUrl || 'http://127.0.0.1:3000',
        payload.pageTitle || 'Auto Practice Session',
      );
    }
    const sessionId = session.id;

    if (session.status === 'PAUSED') {
      throw new BadRequestException('Session is paused. Resume the session to continue solving.');
    }
    if (session.status === 'STOPPED') {
      throw new BadRequestException('Session is stopped.');
    }

    // Make sure the question is on the session record so results and metrics include it
    if (!session.questions.some((q) => q.fingerprint === questionFingerprint)) {
      session = this.sessionsService.recordExtractedQuestions(sessionId, [
        {
          fingerprint: questionFingerprint,
          questionNumber: payload.questionNumber,
          questionText: question,
          options,
          extractionStrategy: 'fallback',
          extractionConfidence: 1,
          status: 'READY_FOR_AI',
        },
      ]);
    }

    // Custom-knowledge notes change answers. An answer made with different notes is stale.
    const knowledgeKey = this.currentKnowledgeKey();

    // 1. Duplicate & Cache Check
    if (!forceFresh) {
      const existingInSession = session.questions.find(
        (q) => q.fingerprint === questionFingerprint && q.aiAnswer,
      );
      if (existingInSession?.aiAnswer && this.isCacheUsable(existingInSession.aiAnswer, knowledgeKey)) {
        const remapped = this.remapAnswer(existingInSession.aiAnswer, existingInSession.options, options);
        if (remapped) {
          this.logger.log(`Serving cached answer for fingerprint ${questionFingerprint} from session`);
          return {
            success: true,
            sessionId,
            questionId: existingInSession.id || uuidv4(),
            answer: remapped,
            cached: true,
            timestamp: new Date().toISOString(),
          };
        }
      }

      // Check global cache table
      const cachedRow = this.db.queryOne<{ response_json: string }>(
        `SELECT response_json FROM cache WHERE fingerprint = ?`,
        [questionFingerprint],
      );
      if (cachedRow?.response_json) {
        try {
          const { answer: cachedAnswer, options: snapshot } = this.readCacheEntry(cachedRow.response_json);
          const remapped = this.isCacheUsable(cachedAnswer, knowledgeKey)
            ? this.remapAnswer(cachedAnswer, snapshot, options)
            : null;
          if (remapped) {
            this.logger.log(`Serving answer for fingerprint ${questionFingerprint} from cache table`);
            this.sessionsService.updateQuestionAnswer(sessionId, questionFingerprint, remapped);
            return {
              success: true,
              sessionId,
              questionId: uuidv4(),
              answer: remapped,
              cached: true,
              timestamp: new Date().toISOString(),
            };
          }
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

      const matchedOpt = verifiedRow?.correct_option_text
        ? this.findOptionByText(verifiedRow.correct_option_text, options)
        : null;
      if (matchedOpt) {
        const verifiedAnswer: AIAnswerResult = {
          selected_option_id: matchedOpt.id,
          answer_text: matchedOpt.text,
          explanation: `Verified correct ground truth from previously recorded portal assessment.`,
          confidence: 1.0,
          needs_review: false,
          verified: true,
        };
        this.logger.log(
          `Serving verified ground truth for question: "${cleanQ.slice(0, 50)}..." -> Option ${matchedOpt.id} (${matchedOpt.text})`,
        );
        this.sessionsService.updateQuestionAnswer(session.id, questionFingerprint, verifiedAnswer);
        return {
          success: true,
          sessionId,
          questionId: uuidv4(),
          answer: verifiedAnswer,
          cached: true,
          timestamp: new Date().toISOString(),
        };
      }
    }

    // 2. Fetch AI credentials & topic knowledge
    const apiKeys = this.configService.getActiveApiKeys();
    if (apiKeys.length === 0) {
      throw new BadRequestException(
        'AI Provider is not configured. Please configure your Gemini API Key(s) in the extension settings.',
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
    if (payload.enableWebSearch && webSearchEvidence.length === 0) {
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
        `Sending question (fingerprint: ${questionFingerprint}) to Gemini model: ${model} [Topic: ${topic}] [WebEvidence: ${webSearchEvidence?.length || 0} snippets] [Images: ${payload.images?.length || 0}] [Queue: ${this.geminiProvider.queueLength}]`,
      );

      const aiAnswer = await this.geminiProvider.generateAnswer(
        question,
        options,
        {
          isMultipleChoiceMultipleAnswer: payload.isMultipleChoiceMultipleAnswer,
          isOrderingQuestion: payload.isOrderingQuestion,
          questionType: payload.questionType,
        },
        apiKeys,
        model,
        topicKnowledge,
        customKnowledgeText,
        webSearchEvidence,
        payload.images,
      );
      aiAnswer.knowledgeKey = knowledgeKey;

      // Save to cache table (with the option texts, so a reshuffled question maps correctly)
      this.db.run(
        `INSERT OR REPLACE INTO cache (fingerprint, response_json, created_at) VALUES (?, ?, ?)`,
        [questionFingerprint, this.writeCacheEntry(aiAnswer, options), new Date().toISOString()],
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
        sessionId,
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

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  /** Hash of the active custom-knowledge notes ('' when there are none). */
  currentKnowledgeKey(): string {
    const notes = this.getCustomKnowledge();
    if (notes.length === 0) return '';
    const raw = notes
      .map((n) => `${n.id}:${n.content}`)
      .sort()
      .join('\n');
    return createHash('sha1').update(raw).digest('hex').slice(0, 16);
  }

  /** Verified answers are always reusable; AI answers only if made with the same notes. */
  private isCacheUsable(answer: AIAnswerResult, knowledgeKey: string): boolean {
    if (answer.verified) return true;
    return (answer.knowledgeKey || '') === knowledgeKey;
  }

  private writeCacheEntry(answer: AIAnswerResult, options: { id: string; text: string }[]): string {
    return JSON.stringify({ answer, options: options.map((o) => ({ id: o.id, text: o.text })) });
  }

  private readCacheEntry(json: string): { answer: AIAnswerResult; options?: { id: string; text: string }[] } {
    const parsed = JSON.parse(json);
    if (parsed && parsed.answer && Array.isArray(parsed.options)) return parsed;
    return { answer: parsed }; // older entries stored the bare answer
  }

  private static normText(t: string): string {
    return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Re-points a cached answer at the current option IDs using option text.
   * Portals often shuffle options on a revisit; the fingerprint ignores order, so without this
   * the cached letter "B" would now point at a different answer. Returns null if it cannot map.
   */
  remapAnswer(
    answer: AIAnswerResult,
    snapshot: { id: string; text: string }[] | undefined,
    current: { id: string; text: string }[],
  ): AIAnswerResult | null {
    if (!snapshot || snapshot.length === 0) return answer;
    const textById = new Map(snapshot.map((o) => [o.id, QuestionsService.normText(o.text)]));
    const idByText = new Map(current.map((o) => [QuestionsService.normText(o.text), o.id]));
    const mapId = (id: string): string | null => {
      const t = textById.get(id.trim());
      return t === undefined ? null : idByText.get(t) ?? null;
    };
    const mapList = (ids: string[]): string[] | null => {
      const out = ids.map(mapId);
      return out.every((x) => x !== null) ? (out as string[]) : null;
    };

    const result: AIAnswerResult = { ...answer };
    if (answer.ordered_sequence?.length) {
      const seq = mapList(answer.ordered_sequence);
      if (!seq) return null;
      result.ordered_sequence = seq;
      result.selected_option_id = seq.join(', ');
      return result;
    }
    if (answer.selected_option_ids?.length) {
      const ids = mapList(answer.selected_option_ids);
      if (!ids) return null;
      result.selected_option_ids = ids;
      result.selected_option_id = ids.join(', ');
      return result;
    }
    const parts = String(answer.selected_option_id).split(/[,;]\s*/).filter(Boolean);
    const ids = mapList(parts);
    if (!ids) return null;
    result.selected_option_id = ids.join(', ');
    return result;
  }

  /** Exact option text first; partial only for longer text with a single candidate ("30" never matches "3000"). */
  private findOptionByText(target: string, options: { id: string; text: string }[]) {
    const strip = (t: string) => QuestionsService.normText(t).replace(/^\(?[a-h1-8][\)\.:]\s+/, '');
    const want = strip(target);
    if (!want) return null;
    const exact = options.find((o) => strip(o.text) === want);
    if (exact) return exact;
    if (want.length < 8) return null;
    const partial = options.filter((o) => {
      const t = strip(o.text);
      return t.length > 0 && (t.includes(want) || want.includes(t));
    });
    return partial.length === 1 ? partial[0] : null;
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
        verified: true,
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

