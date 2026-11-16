const calls: string[] = [];
const keyCalls: string[] = [];
const limited = new Set<string>();
const dailyLimited = new Set<string>();
const limitedKeys = new Set<string>();
const MCQ_JSON = JSON.stringify({ selected_option_id: 'A', answer_text: 'x', explanation: '', confidence: 0.9, needs_review: false });
let mockJson = MCQ_JSON;

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation((apiKey: string) => ({
    getGenerativeModel: ({ model }: { model: string }) => ({
      generateContent: async () => {
        calls.push(model);
        keyCalls.push(apiKey);
        if (limitedKeys.has(apiKey)) {
          throw new Error('[429 Too Many Requests] Resource has been exhausted (e.g. check quota).');
        }
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
  const ask = (p: GeminiProvider, model: string, keys: string | string[] = 'key_primary_12345') =>
    p.generateAnswer('q?', [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], undefined, keys, model);

  beforeEach(() => {
    mockJson = MCQ_JSON;
    calls.length = 0;
    keyCalls.length = 0;
    limited.clear();
    dailyLimited.clear();
    limitedKeys.clear();
  });

  it('rotates to next API key when current key hits rate limit', async () => {
    const p = new GeminiProvider();
    const key1 = 'AIzaSyKeyOne_Account1';
    const key2 = 'AIzaSyKeyTwo_Account2';
    const key3 = 'AIzaSyKeyThree_Account3';

    limitedKeys.add(key1);

    const res = await ask(p, 'gemini-3.5-flash-lite', [key1, key2, key3]);
    expect(res.selected_option_id).toBe('A');
    expect(keyCalls).toContain(key1);
    expect(keyCalls).toContain(key2);
    // Key 2 should have succeeded
    expect(p.getActiveKeyIndex([key1, key2, key3])).toBe(1);

    // On next question, Key 1 is skipped because it is on cooldown
    keyCalls.length = 0;
    await ask(p, 'gemini-3.5-flash-lite', [key1, key2, key3]);
    expect(keyCalls).toEqual([key2]);
  });

  it('cycles across 3 API keys and reports when all keys are rate limited', async () => {
    const p = new GeminiProvider();
    const key1 = 'AIzaSyKeyOne_Account1';
    const key2 = 'AIzaSyKeyTwo_Account2';

    limitedKeys.add(key1);
    limitedKeys.add(key2);

    await expect(ask(p, 'gemini-3.5-flash-lite', [key1, key2])).rejects.toThrow(
      /429 All 2 configured Gemini API key\(s\) are rate-limited/,
    );
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
