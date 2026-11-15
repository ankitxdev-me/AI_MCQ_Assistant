const calls: string[] = [];
const limited = new Set<string>();
const dailyLimited = new Set<string>();
const MCQ_JSON = JSON.stringify({ selected_option_id: 'A', answer_text: 'x', explanation: '', confidence: 0.9, needs_review: false });
let mockJson = MCQ_JSON;

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: ({ model }: { model: string }) => ({
      generateContent: async () => {
        calls.push(model);
        if (dailyLimited.has(model)) {
          throw new Error('[429 Too Many Requests] Quota exceeded for metric: generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel');
        }
        if (limited.has(model)) {
          throw new Error('[429 Too Many Requests] Quota exceeded. Please retry in 20s.');
        }
        return { response: { text: () => mockJson } };
      },
    }),
  })),
}));

import { GeminiProvider, msUntilPacificMidnight, cleanTypedAnswer } from './gemini.provider';

describe('Gemini model rotation under rate limits', () => {
  const ask = (p: GeminiProvider, model: string) =>
    p.generateAnswer('q?', [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], undefined, 'key', model);

  beforeEach(() => {
    mockJson = MCQ_JSON;
    calls.length = 0;
    limited.clear();
    dailyLimited.clear();
  });

  it('moves to the next model at once and skips the limited one on later questions', async () => {
    const p = new GeminiProvider();
    limited.add('gemini-3.1-flash-lite');

    await ask(p, 'gemini-3.1-flash-lite');
    expect(calls).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);

    calls.length = 0;
    await ask(p, 'gemini-3.1-flash-lite');
    expect(calls).toEqual(['gemini-3.5-flash-lite']); // no wasted call on the parked model
    expect(p.getCooldowns().map((c) => c.model)).toContain('gemini-3.1-flash-lite');
  });

  it('parks a model that hit its daily quota until midnight Pacific', async () => {
    const p = new GeminiProvider();
    dailyLimited.add('gemini-3.5-flash-lite');
    await ask(p, 'gemini-3.5-flash-lite');
    const parked = p.getCooldowns().find((c) => c.model === 'gemini-3.5-flash-lite');
    expect(parked!.secondsLeft).toBeGreaterThan(60);
    expect(parked!.secondsLeft * 1000).toBeLessThanOrEqual(msUntilPacificMidnight() + 2000);
  });

  it('reports when every model is limited, with the wait time, so the loop can pause and resume', async () => {
    const p = new GeminiProvider();
    GeminiProvider.FALLBACK_MODELS.forEach((m) => limited.add(m));
    await expect(ask(p, 'gemini-3.5-flash-lite')).rejects.toThrow(/429 All Gemini models are rate limited\. Please retry in \d+s/);
  });

  it('solves typed-answer questions (no options) and cleans the text to type', async () => {
    const p = new GeminiProvider();
    mockJson = JSON.stringify({ selected_option_id: '17', answer_text: 'Answer: 17.', explanation: 'p[3]-p[0]', confidence: 0.95, needs_review: false });
    const r = await p.generateAnswer('Sum from index 1 to 3 of prefix [3, 8, 12, 20]?', [], { questionType: 'DESCRIPTIVE' }, 'key', 'gemini-3.5-flash-lite');
    expect(r.selected_option_id).toBe('TEXT');
    expect(r.answer_text).toBe('17');
    expect(r.needs_review).toBe(false);
  });

  it('cleanTypedAnswer strips quotes, prefixes and a trailing full stop only on short answers', () => {
    expect(cleanTypedAnswer('"O(log n)"')).toBe('O(log n)');
    expect(cleanTypedAnswer('`git checkout -b dev`')).toBe('git checkout -b dev');
    expect(cleanTypedAnswer('Final answer: 42.')).toBe('42');
    expect(cleanTypedAnswer('```js\nconsole.log(1)\n```')).toBe('console.log(1)');
  });
});
