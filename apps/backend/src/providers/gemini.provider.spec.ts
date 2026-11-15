import { GeminiProvider } from './gemini.provider';

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider();
  });

  it('should list available models', () => {
    const models = provider.getAvailableModels();
    expect(models).toContain(GeminiProvider.DEFAULT_MODEL);
    expect(models.some((m) => m.startsWith('gemini-1.5') || m.startsWith('gemini-2.0'))).toBe(false);
  });

  it('should return failure when validating connection without API key', async () => {
    delete process.env.GEMINI_API_KEY;
    const result = await provider.validateConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain('No Gemini API key');
  });

  it('should clean markdown json blocks properly', () => {
    const cleanFn = (provider as any).cleanJsonResponse;
    const raw = '```json\n{"selected_option_id": "B"}\n```';
    expect(cleanFn(raw)).toBe('{"selected_option_id": "B"}');
  });
});

