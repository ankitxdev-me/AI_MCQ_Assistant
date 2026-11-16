import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../common/database.service';
import { GeminiProvider } from '../providers/gemini.provider';
import {
  ConfigStatusResponse,
  TestConnectionResponse,
} from '@ai-mcq/shared-types';

@Injectable()
export class ConfigService {
  private readonly logger = new Logger(ConfigService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly geminiProvider: GeminiProvider,
  ) {}

  getConfigStatus(): ConfigStatusResponse {
    const dbKeyRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_api_key'`,
    );
    const dbModelRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_model'`,
    );
    const lastTestedRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'last_tested'`,
    );

    const keys = this.getActiveApiKeys();
    const envKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS;
    const hasDbKey = !!dbKeyRow?.value;
    const hasEnvFallback = !!envKey;

    let source: 'database' | 'environment' | 'none' = 'none';
    if (hasDbKey) {
      source = 'database';
    } else if (hasEnvFallback) {
      source = 'environment';
    }

    const isConfigured = keys.length > 0;
    const selectedModel =
      dbModelRow?.value || process.env.GEMINI_DEFAULT_MODEL || GeminiProvider.DEFAULT_MODEL;

    const maskedKeys = keys.map((k) => this.geminiProvider.maskKey(k));
    const activeKeyIndex = this.geminiProvider.getActiveKeyIndex(keys);
    const keyCooldowns = this.geminiProvider.getKeyCooldowns(keys);

    return {
      configured: isConfigured,
      provider: 'gemini',
      model: selectedModel,
      hasEnvFallback,
      source,
      availableModels: this.geminiProvider.getAvailableModels(),
      lastTested: lastTestedRow?.value,
      pairingTokenConfigured: !!(process.env.API_PAIRING_TOKEN || 'ai_mcq_assistant_secret_token_change_in_production'),
      keyCount: keys.length,
      activeKeyIndex,
      maskedKeys,
      keyCooldowns,
    };
  }

  getActiveApiKeys(): string[] {
    // 1. Check gemini_api_keys JSON array in DB
    const dbKeysRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_api_keys'`,
    );
    if (dbKeysRow?.value) {
      try {
        const parsed = JSON.parse(dbKeysRow.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed.map((k) => String(k).trim()).filter((k) => k.length > 0);
          if (valid.length > 0) return Array.from(new Set(valid));
        }
      } catch {
        // Fall through
      }
    }

    // 2. Check legacy single gemini_api_key in DB (split by newlines/commas)
    const dbKeyRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_api_key'`,
    );
    if (dbKeyRow?.value) {
      const split = dbKeyRow.value
        .split(/[\r\n,;]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (split.length > 0) return Array.from(new Set(split));
    }

    // 3. Environment variables fallback
    if (process.env.GEMINI_API_KEYS) {
      const envKeys = process.env.GEMINI_API_KEYS.split(/[\r\n,;]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      if (envKeys.length > 0) return Array.from(new Set(envKeys));
    }
    if (process.env.GEMINI_API_KEY) {
      const k = process.env.GEMINI_API_KEY.trim();
      if (k.length > 0) return [k];
    }

    return [];
  }

  getActiveApiKey(): string | null {
    const keys = this.getActiveApiKeys();
    return keys.length > 0 ? keys[0] : null;
  }

  getActiveModel(): string {
    const dbModelRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_model'`,
    );
    return dbModelRow?.value || process.env.GEMINI_DEFAULT_MODEL || GeminiProvider.DEFAULT_MODEL;
  }

  async saveGeminiConfig(
    apiKeyInput: string | string[],
    model: string = GeminiProvider.DEFAULT_MODEL,
    additionalKeys?: string[],
  ) {
    const rawKeys: string[] = [];
    if (Array.isArray(apiKeyInput)) {
      rawKeys.push(...apiKeyInput);
    } else if (typeof apiKeyInput === 'string') {
      rawKeys.push(...apiKeyInput.split(/[\r\n,;]+/));
    }

    if (Array.isArray(additionalKeys)) {
      rawKeys.push(...additionalKeys);
    }

    const cleanedKeys = Array.from(new Set(rawKeys.map((k) => k.trim()).filter((k) => k.length > 0)));
    const now = new Date().toISOString();

    if (cleanedKeys.length > 0) {
      // Save primary key for legacy compatibility
      this.db.run(
        `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)`,
        [cleanedKeys[0], now],
      );
      // Save full array of keys in gemini_api_keys
      this.db.run(
        `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_api_keys', ?, ?)`,
        [JSON.stringify(cleanedKeys), now],
      );
    }

    this.db.run(
      `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_model', ?, ?)`,
      [model.trim(), now],
    );

    this.logger.log(
      `Gemini API configuration securely saved in local database (${cleanedKeys.length} key(s) in fallback pool)`,
    );
    return this.getConfigStatus();
  }

  async updateModel(model: string) {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_model', ?, ?)`,
      [model.trim(), now],
    );
    this.logger.log(`Active model updated to ${model.trim()}`);
    return this.getConfigStatus();
  }

  async testConnection(
    testApiKey?: string | string[],
    testModel?: string,
  ): Promise<TestConnectionResponse> {
    let keysToTest: string[] = [];
    if (Array.isArray(testApiKey)) {
      keysToTest = testApiKey;
    } else if (typeof testApiKey === 'string' && testApiKey.trim().length > 0) {
      keysToTest = testApiKey.split(/[\r\n,;]+/);
    } else {
      keysToTest = this.getActiveApiKeys();
    }

    const cleanedKeys = Array.from(new Set(keysToTest.map((k) => k.trim()).filter((k) => k.length > 0)));
    const model = testModel || this.getActiveModel();

    if (cleanedKeys.length === 0) {
      return {
        success: false,
        message: 'No API key configured to test. Please provide at least one API key.',
        modelTested: model,
        timestamp: new Date().toISOString(),
      };
    }

    const testResult = await this.geminiProvider.validateConnection({
      apiKeys: cleanedKeys,
      model,
    });

    if (testResult.success) {
      this.db.run(
        `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('last_tested', ?, ?)`,
        [new Date().toISOString(), new Date().toISOString()],
      );
    }

    return {
      success: testResult.success,
      message: testResult.message,
      modelTested: testResult.model,
      timestamp: new Date().toISOString(),
    };
  }

  deleteProviderConfig() {
    this.db.run(
      `DELETE FROM configs WHERE key IN ('gemini_api_key', 'gemini_api_keys', 'gemini_model', 'last_tested')`,
    );
    this.logger.log('Gemini API configuration removed from local database');
    return this.getConfigStatus();
  }
}

