import { SessionsService } from './sessions.service';
import { DatabaseService } from '../common/database.service';
import { EventsGateway } from '../events/events.gateway';
import initSqlJs from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';

describe('SessionsService', () => {
  let service: SessionsService;
  let db: DatabaseService;
  let eventsGateway: EventsGateway;
  const testDbPath = path.resolve(process.cwd(), 'data', 'test_sessions.db');

  beforeAll(async () => {
    process.env.DATABASE_FILE = './data/test_sessions.db';
    db = new DatabaseService();
    await db.onModuleInit();

    eventsGateway = new EventsGateway();
    service = new SessionsService(db, eventsGateway);
  });

  afterAll(() => {
    db.onModuleDestroy();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (e) {}
    }
  });

  it('should create a practice session', () => {
    const session = service.createSession('https://practice.portal.test/quiz/1', 'Test Quiz', 101);
    expect(session.id).toBeDefined();
    expect(session.pageUrl).toBe('https://practice.portal.test/quiz/1');
    expect(session.status).toBe('ACTIVE');
    expect(session.totalDetected).toBe(0);
  });

  it('should record extracted questions and update totalDetected', () => {
    const session = service.createSession('https://practice.portal.test/quiz/2');
    const updated = service.recordExtractedQuestions(session.id, [
      {
        fingerprint: 'fp_q1',
        questionText: 'What is 2+2?',
        options: [
          { id: 'A', text: '3' },
          { id: 'B', text: '4' },
        ],
        extractionStrategy: 'radio-standard',
        extractionConfidence: 1.0,
        status: 'READY_FOR_AI',
      },
      {
        fingerprint: 'fp_q2',
        questionText: 'What is the capital of France?',
        options: [
          { id: 'A', text: 'London' },
          { id: 'B', text: 'Paris' },
        ],
        extractionStrategy: 'radio-standard',
        extractionConfidence: 1.0,
        status: 'READY_FOR_AI',
      },
    ]);

    expect(updated.totalDetected).toBe(2);
    expect(updated.questions.length).toBe(2);
  });

  it('should handle pause, resume, and stop state transitions', () => {
    const session = service.createSession('https://practice.portal.test/quiz/3');
    expect(session.status).toBe('ACTIVE');

    const paused = service.pauseSession(session.id);
    expect(paused.status).toBe('PAUSED');

    const resumed = service.resumeSession(session.id);
    expect(resumed.status).toBe('ACTIVE');

    const stopped = service.stopSession(session.id);
    expect(stopped.status).toBe('STOPPED');
    expect(stopped.endTime).toBeDefined();
  });

  it('should update question answer and metrics', () => {
    const session = service.createSession('https://practice.portal.test/quiz/4');
    service.recordExtractedQuestions(session.id, [
      {
        fingerprint: 'fp_q_ans',
        questionText: 'Which data structure follows FIFO?',
        options: [
          { id: 'A', text: 'Stack' },
          { id: 'B', text: 'Queue' },
        ],
        extractionStrategy: 'radio-standard',
        extractionConfidence: 1.0,
        status: 'READY_FOR_AI',
      },
    ]);

    const updated = service.updateQuestionAnswer(session.id, 'fp_q_ans', {
      selected_option_id: 'B',
      answer_text: 'Queue',
      explanation: 'Queue follows First In First Out.',
      confidence: 0.99,
      needs_review: false,
    });

    expect(updated.processedCount).toBe(1);
    expect(updated.needsReviewCount).toBe(0);
    const q = updated.questions.find((x) => x.fingerprint === 'fp_q_ans');
    expect(q?.aiAnswer?.selected_option_id).toBe('B');
  });
});

