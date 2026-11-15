import { QuestionsService } from './questions.service';
import { DatabaseService } from '../common/database.service';
import { WebSearchService } from '../common/web-search.service';
import { ConfigService } from '../config/config.service';
import { GeminiProvider } from '../providers/gemini.provider';
import { SessionsService } from '../sessions/sessions.service';
import { EventsGateway } from '../events/events.gateway';
import * as fs from 'fs';
import * as path from 'path';

describe('QuestionsService', () => {
  let service: QuestionsService;
  let db: DatabaseService;
  let configService: ConfigService;
  let geminiProvider: GeminiProvider;
  let sessionsService: SessionsService;
  let eventsGateway: EventsGateway;
  const testDbPath = path.resolve(process.cwd(), 'data', 'test_questions.db');

  beforeAll(async () => {
    process.env.DATABASE_FILE = './data/test_questions.db';
    db = new DatabaseService();
    await db.onModuleInit();

    geminiProvider = new GeminiProvider();
    configService = new ConfigService(db, geminiProvider);
    eventsGateway = new EventsGateway();
    sessionsService = new SessionsService(db, eventsGateway);
    const webSearchService = new WebSearchService();
    service = new QuestionsService(
      db,
      configService,
      geminiProvider,
      sessionsService,
      eventsGateway,
      webSearchService,
    );

    // Seed mock config
    await configService.saveGeminiConfig('mock-api-key', 'gemini-1.5-flash');
  });

  afterAll(() => {
    db.onModuleDestroy();
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch (e) {}
    }
  });

  it('should prevent duplicate AI requests by using session and global cache', async () => {
    const session = sessionsService.createSession('https://test.local/quiz');
    const fingerprint = 'fp_dup_test_123';

    sessionsService.recordExtractedQuestions(session.id, [
      {
        fingerprint,
        questionText: 'What is 10 / 2?',
        options: [
          { id: 'A', text: '4' },
          { id: 'B', text: '5' },
        ],
        extractionStrategy: 'radio-standard',
        extractionConfidence: 1.0,
        status: 'READY_FOR_AI',
      },
    ]);

    // Mock gemini generateAnswer
    const mockAnswer = {
      selected_option_id: 'B',
      answer_text: '5',
      explanation: '10 divided by 2 equals 5.',
      confidence: 1.0,
      needs_review: false,
    };
    const generateSpy = jest
      .spyOn(geminiProvider, 'generateAnswer')
      .mockResolvedValue(mockAnswer);

    // First solve: should call generateAnswer
    const res1 = await service.solveQuestion({
      sessionId: session.id,
      question: 'What is 10 / 2?',
      options: [
        { id: 'A', text: '4' },
        { id: 'B', text: '5' },
      ],
      questionFingerprint: fingerprint,
    });

    expect(res1.success).toBe(true);
    expect(res1.cached).toBe(false);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Second solve with same fingerprint: should return cached answer without calling generateAnswer again
    const res2 = await service.solveQuestion({
      sessionId: session.id,
      question: 'What is 10 / 2?',
      options: [
        { id: 'A', text: '4' },
        { id: 'B', text: '5' },
      ],
      questionFingerprint: fingerprint,
    });

    expect(res2.success).toBe(true);
    expect(res2.cached).toBe(true);
    expect(res2.answer.selected_option_id).toBe('B');
    // Still called only 1 time!
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });
});

