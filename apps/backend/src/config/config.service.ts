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

    const envKey = process.env.GEMINI_API_KEY;
    const hasDbKey = !!dbKeyRow?.value;
    const hasEnvFallback = !!envKey;

    let source: 'database' | 'environment' | 'none' = 'none';
    if (hasDbKey) {
      source = 'database';
    } else if (hasEnvFallback) {
      source = 'environment';
    }

    const isConfigured = hasDbKey || hasEnvFallback;
    const selectedModel =

      dbModelRow?.value || process.env.GEMINI_DEFAULT_MODEL || GeminiProvider.DEFAULT_MODEL;


    return {
      configured: isConfigured,
      provider: 'gemini',
      model: selectedModel,
      hasEnvFallback,
      source,
      availableModels: this.geminiProvider.getAvailableModels(),
      lastTested: lastTestedRow?.value,
      pairingTokenConfigured: !!(process.env.API_PAIRING_TOKEN || 'ai_mcq_assistant_secret_token_change_in_production'),
    };
  }

  getActiveApiKey(): string | null {
    // 1. User configured key in DB
    const dbKeyRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_api_key'`,
    );
    if (dbKeyRow?.value) {
      return dbKeyRow.value;
    }
    // 2. Development environment fallback
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY;
    }
    return null;
  }

  getActiveModel(): string {
    const dbModelRow = this.db.queryOne<{ value: string }>(
      `SELECT value FROM configs WHERE key = 'gemini_model'`,
    );
    return dbModelRow?.value || process.env.GEMINI_DEFAULT_MODEL || GeminiProvider.DEFAULT_MODEL;
  }

  async saveGeminiConfig(apiKey: string, model: string = GeminiProvider.DEFAULT_MODEL) {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_api_key', ?, ?)`,
      [apiKey.trim(), now],
    );
    this.db.run(
      `INSERT OR REPLACE INTO configs (key, value, updated_at) VALUES ('gemini_model', ?, ?)`,
      [model.trim(), now],
    );

    this.logger.log('Gemini API configuration securely saved in local database');
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

  async testConnection(testApiKey?: string, testModel?: string): Promise<TestConnectionResponse> {
    const apiKey = testApiKey || this.getActiveApiKey();
    const model = testModel || this.getActiveModel();

    if (!apiKey) {
      return {
        success: false,
        message: 'No API key configured to test. Please provide an API key.',
        modelTested: model,
        timestamp: new Date().toISOString(),
      };
    }

    const testResult = await this.geminiProvider.validateConnection({
      apiKey,
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
    this.db.run(`DELETE FROM configs WHERE key IN ('gemini_api_key', 'gemini_model', 'last_tested')`);
    this.logger.log('Gemini API configuration removed from local database');
    return this.getConfigStatus();
  }
}

