import { QuestionsService } from './questions.service';
import { DatabaseService } from '../common/database.service';
import { WebSearchService } from '../common/web-search.service';
import { ConfigService } from '../config/config.service';
import { GeminiProvider, parseRetryDelayMs } from '../providers/gemini.provider';
import { SessionsService } from '../sessions/sessions.service';
import { EventsGateway } from '../events/events.gateway';
import * as fs from 'fs';
import * as path from 'path';

describe('Answer cache and knowledge base', () => {
  let service: QuestionsService;
  let db: DatabaseService;
  let gemini: GeminiProvider;
  const dbPath = path.resolve(process.cwd(), 'data', 'test_cache.db');

  beforeAll(async () => {
    process.env.DATABASE_FILE = './data/test_cache.db';
    db = new DatabaseService();
    await db.onModuleInit();
    gemini = new GeminiProvider();
    const config = new ConfigService(db, gemini);
    const events = new EventsGateway();
    const sessions = new SessionsService(db, events);
    service = new QuestionsService(db, config, gemini, sessions, events, new WebSearchService());
    await config.saveGeminiConfig('mock-api-key', GeminiProvider.DEFAULT_MODEL);
  });

  afterAll(() => {
    db.onModuleDestroy();
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  afterEach(() => jest.restoreAllMocks());

  const baseQuestion = {
    question: 'Which port does app.listen(3001) use?',
    options: [
      { id: 'A', text: '3000' },
      { id: 'B', text: '30' },
      { id: 'C', text: '3001' },
      { id: 'D', text: '300' },
    ],
    questionFingerprint: 'fp_port_q',
  };

  it('re-asks Gemini after the knowledge base changes instead of serving a stale cached answer', async () => {
    const spy = jest.spyOn(gemini, 'generateAnswer').mockResolvedValue({
      selected_option_id: 'C',
      answer_text: '3001',
      explanation: 'listen(3001)',
      confidence: 0.95,
      needs_review: false,
    });

    const first = await service.solveQuestion({ ...baseQuestion, questionFingerprint: 'fp_kb' });
    expect(first.cached).toBe(false);

    const second = await service.solveQuestion({ ...baseQuestion, questionFingerprint: 'fp_kb' });
    expect(second.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const note = service.saveCustomKnowledge('Ports', 'Our servers always listen on 3001.');
    const third = await service.solveQuestion({ ...baseQuestion, questionFingerprint: 'fp_kb' });
    expect(third.cached).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    // and the note text actually reached the prompt
    expect(spy.mock.calls[1][6]).toContain('Our servers always listen on 3001.');

    service.deleteCustomKnowledge(note.id);
  });

  it('maps a cached answer onto shuffled options by text, not by stale letter', async () => {
    jest.spyOn(gemini, 'generateAnswer').mockResolvedValue({
      selected_option_id: 'C',
      answer_text: '3001',
      explanation: '',
      confidence: 0.95,
      needs_review: false,
    });
    await service.solveQuestion({ ...baseQuestion, questionFingerprint: 'fp_shuffle' });

    // Same question revisited with options in a different order (same fingerprint)
    const shuffled = await service.solveQuestion({
      ...baseQuestion,
      questionFingerprint: 'fp_shuffle',
      options: [
        { id: 'A', text: '3001' },
        { id: 'B', text: '300' },
        { id: 'C', text: '30' },
        { id: 'D', text: '3000' },
      ],
    });
    expect(shuffled.cached).toBe(true);
    expect(shuffled.answer.selected_option_id).toBe('A');
  });

  it('serves recorded ground truth by exact text ("30" never matches "3000")', async () => {
    service.recordQuestionFeedback({
      questionFingerprint: 'fp_truth_other',
      questionText: 'Pick thirty',
      selectedOptionId: 'B',
      selectedOptionText: '30',
      isCorrect: true,
    });
    const spy = jest.spyOn(gemini, 'generateAnswer');
    const res = await service.solveQuestion({
      question: 'Pick thirty',
      options: [
        { id: 'A', text: '3000' },
        { id: 'B', text: '300' },
        { id: 'C', text: '30' },
      ],
      questionFingerprint: 'fp_truth_new',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(res.answer.selected_option_id).toBe('C');
  });

  it('reads the wait time Gemini asks for on a 429', () => {
    expect(parseRetryDelayMs('[429 Too Many Requests] ... "retryDelay":"23s"')).toBe(23000);
    expect(parseRetryDelayMs('Quota exceeded. Please retry in 7.5s.')).toBe(7500);
    expect(parseRetryDelayMs('Some other error')).toBeNull();
  });

  it('queues Gemini calls instead of firing them all at once', async () => {
    let running = 0;
    let peak = 0;
    const unqueued = jest.spyOn(gemini as any, 'generateAnswerUnqueued').mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { selected_option_id: 'A', answer_text: 'x', explanation: '', confidence: 1, needs_review: false };
    });
    await Promise.all(
      Array.from({ length: 6 }, () => gemini.generateAnswer('q', [{ id: 'A', text: 'x' }], undefined, 'key')),
    );
    expect(unqueued).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
