import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { DatabaseService } from '../common/database.service';
import { EventsGateway } from '../events/events.gateway';
import { v4 as uuidv4 } from 'uuid';
import {
  PracticeSession,
  SessionStatus,
  ExtractedQuestion,
  AIAnswerResult,
} from '@ai-mcq/shared-types';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  createSession(pageUrl: string, pageTitle?: string, tabId?: number): PracticeSession {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO sessions (
        id, tab_id, page_url, page_title, status,
        total_detected, processed_count, needs_review_count, failed_count,
        current_question_index, start_time, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tabId || null, pageUrl, pageTitle || '', 'ACTIVE', 0, 0, 0, 0, 0, now, now],
    );

    const session = this.getSession(id);
    this.eventsGateway.emitSessionUpdated(session);
    return session;
  }

  getSession(id: string): PracticeSession {
    const row = this.db.queryOne<any>(`SELECT * FROM sessions WHERE id = ?`, [id]);
    if (!row) {
      throw new NotFoundException(`Session ${id} not found`);
    }

    const questionRows = this.db.query<any>(
      `SELECT * FROM questions WHERE session_id = ? ORDER BY question_number ASC, detected_at ASC`,
      [id],
    );

    const questions: PracticeSession['questions'] = questionRows.map((q) => {
      let options = [];
      try {
        options = JSON.parse(q.options_json);
      } catch (e) {
        options = [];
      }

      let aiAnswer: AIAnswerResult | undefined;
      if (q.ai_answer_json) {
        try {
          aiAnswer = JSON.parse(q.ai_answer_json);
        } catch (e) {
          aiAnswer = undefined;
        }
      }

      return {
        id: q.id,
        fingerprint: q.fingerprint,
        questionNumber: q.question_number,
        questionText: q.question_text,
        options,
        extractionStrategy: q.extraction_strategy,
        extractionConfidence: q.extraction_confidence,
        elementSelector: q.element_selector,
        status: q.status,
        detectedAt: q.detected_at,
        completedAt: q.completed_at,
        userConfirmedSelection: q.user_confirmed_selection,
        aiAnswer,
      };
    });

    return {
      id: row.id,
      tabId: row.tab_id,
      pageUrl: row.page_url,
      pageTitle: row.page_title,
      status: row.status as SessionStatus,
      totalDetected: row.total_detected,
      processedCount: row.processed_count,
      needsReviewCount: row.needs_review_count,
      failedCount: row.failed_count,
      currentQuestionIndex: row.current_question_index,
      currentQuestionFingerprint: row.current_question_fingerprint,
      startTime: row.start_time,
      endTime: row.end_time,
      questions,
    };
  }

  pauseSession(id: string): PracticeSession {
    const session = this.getSession(id);
    this.db.run(`UPDATE sessions SET status = 'PAUSED' WHERE id = ?`, [id]);
    const updated = this.getSession(id);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }

  resumeSession(id: string): PracticeSession {
    const session = this.getSession(id);
    this.db.run(`UPDATE sessions SET status = 'ACTIVE' WHERE id = ?`, [id]);
    const updated = this.getSession(id);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }

  stopSession(id: string): PracticeSession {
    const session = this.getSession(id);
    const now = new Date().toISOString();
    this.db.run(`UPDATE sessions SET status = 'STOPPED', end_time = ? WHERE id = ?`, [now, id]);
    const updated = this.getSession(id);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }

  recordExtractedQuestions(sessionId: string, extractedQuestions: ExtractedQuestion[]): PracticeSession {
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();

    for (let i = 0; i < extractedQuestions.length; i++) {
      const q = extractedQuestions[i];
      const existing = this.db.queryOne<any>(
        `SELECT id FROM questions WHERE session_id = ? AND fingerprint = ?`,
        [sessionId, q.fingerprint],
      );

      if (!existing) {
        const questionId = q.id || uuidv4();
        this.db.run(
          `INSERT INTO questions (
            id, session_id, fingerprint, question_number, question_text,
            options_json, extraction_strategy, extraction_confidence,
            status, element_selector, detected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            questionId,
            sessionId,
            q.fingerprint,
            q.questionNumber || i + 1,
            q.questionText,
            JSON.stringify(q.options),
            q.extractionStrategy,
            q.extractionConfidence,
            'READY_FOR_AI',
            q.elementSelector || null,
            now,
          ],
        );
      }
    }

    // Update total detected count
    const totalCountRow = this.db.queryOne<{ count: number }>(
      `SELECT count(*) as count FROM questions WHERE session_id = ?`,
      [sessionId],
    );
    const totalCount = totalCountRow?.count || 0;

    this.db.run(
      `UPDATE sessions SET total_detected = ? WHERE id = ?`,
      [totalCount, sessionId],
    );

    const updated = this.getSession(sessionId);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }

  updateQuestionAnswer(
    sessionId: string,
    questionFingerprint: string,
    aiAnswer: AIAnswerResult,
  ): PracticeSession {
    const now = new Date().toISOString();
    const status = aiAnswer.needs_review ? 'NEEDS_REVIEW' : 'ANSWER_READY';

    this.db.run(
      `UPDATE questions
       SET ai_answer_json = ?, status = ?, completed_at = ?
       WHERE session_id = ? AND fingerprint = ?`,
      [JSON.stringify(aiAnswer), status, now, sessionId, questionFingerprint],
    );

    // Update session metrics
    const stats = this.db.queryOne<{ processed: number; needsReview: number; failed: number }>(
      `SELECT
        SUM(CASE WHEN status IN ('ANSWER_READY', 'COMPLETED', 'NEEDS_REVIEW') THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) as needsReview,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
       FROM questions WHERE session_id = ?`,
      [sessionId],
    );

    this.db.run(
      `UPDATE sessions
       SET processed_count = ?, needs_review_count = ?, failed_count = ?,
           current_question_fingerprint = ?
       WHERE id = ?`,
      [
        stats?.processed || 0,
        stats?.needsReview || 0,
        stats?.failed || 0,
        questionFingerprint,
        sessionId,
      ],
    );

    const updated = this.getSession(sessionId);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }

  confirmQuestionAnswer(
    sessionId: string,
    questionFingerprint: string,
    selectedOptionId: string,
  ): PracticeSession {
    this.db.run(
      `UPDATE questions
       SET user_confirmed_selection = ?, status = 'COMPLETED'
       WHERE session_id = ? AND fingerprint = ?`,
      [selectedOptionId, sessionId, questionFingerprint],
    );

    const updated = this.getSession(sessionId);
    this.eventsGateway.emitSessionUpdated(updated);
    return updated;
  }
}

