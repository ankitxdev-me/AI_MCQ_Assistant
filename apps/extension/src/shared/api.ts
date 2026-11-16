import {
  ConfigStatusResponse,
  TestConnectionResponse,
  PracticeSession,
  SolveQuestionPayload,
  SolveQuestionResponse,
  ExtractedQuestion,
  QuestionFeedbackPayload,
  CustomKnowledgeItem,
} from '@ai-mcq/shared-types';

const BACKEND_BASE = 'http://127.0.0.1:3000';
const DEFAULT_TOKEN = 'ai_mcq_assistant_secret_token_change_in_production';

async function getStoredPairingToken(): Promise<string> {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const res = await chrome.storage.local.get(['pairingToken']);
    return res.pairingToken || DEFAULT_TOKEN;
  }
  return DEFAULT_TOKEN;
}

export async function requestBackend<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = await getStoredPairingToken();
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('x-pairing-token', token);

  try {
    const res = await fetch(`${BACKEND_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `HTTP ${res.status}`);
    }

    return await res.json();
  } catch (err: any) {
    // If direct fetch is blocked by CORS/content isolation, fallback to background service worker
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const response = await chrome.runtime.sendMessage({
        type: 'BACKEND_FETCH',
        payload: {
          endpoint,
          options: {
            method: options.method,
            body: options.body,
          },
        },
      });
      if (response && response.success) {
        return response.data;
      }
      if (response && response.error) {
        throw new Error(response.error);
      }
    }
    throw err;
  }
}

export const ApiClient = {
  async getHealth(): Promise<{ status: string; uptime: number }> {
    return requestBackend('/api/health');
  },

  async getConfigStatus(): Promise<ConfigStatusResponse> {
    return requestBackend('/api/config/status');
  },

  async saveGeminiConfig(apiKey: string, model: string, apiKeys?: string[]): Promise<ConfigStatusResponse> {
    return requestBackend('/api/config/gemini', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gemini', apiKey, model, apiKeys }),
    });
  },

  async testConnection(apiKey?: string, model?: string, apiKeys?: string[]): Promise<TestConnectionResponse> {
    return requestBackend('/api/config/test', {
      method: 'POST',
      body: JSON.stringify({ apiKey, model, apiKeys }),
    });
  },

  async deleteConfig(): Promise<ConfigStatusResponse> {
    return requestBackend('/api/config/provider', {
      method: 'DELETE',
    });
  },

  async createSession(pageUrl: string, pageTitle?: string, tabId?: number): Promise<PracticeSession> {
    return requestBackend('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ pageUrl, pageTitle, tabId }),
    });
  },

  async getSession(sessionId: string): Promise<PracticeSession> {
    return requestBackend(`/api/sessions/${sessionId}`);
  },

  async pauseSession(sessionId: string): Promise<PracticeSession> {
    return requestBackend(`/api/sessions/${sessionId}/pause`, { method: 'POST' });
  },

  async resumeSession(sessionId: string): Promise<PracticeSession> {
    return requestBackend(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
  },

  async stopSession(sessionId: string): Promise<PracticeSession> {
    return requestBackend(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
  },

  async extractQuestions(sessionId: string, questions: ExtractedQuestion[]): Promise<any> {
    return requestBackend('/api/questions/extract', {
      method: 'POST',
      body: JSON.stringify({ sessionId, questions }),
    });
  },

  async solveQuestion(payload: SolveQuestionPayload): Promise<SolveQuestionResponse> {
    return requestBackend('/api/questions/solve', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async confirmSelection(
    sessionId: string,
    questionFingerprint: string,
    selectedOptionId: string,
  ): Promise<PracticeSession> {
    return requestBackend(`/api/sessions/${sessionId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ questionFingerprint, selectedOptionId }),
    });
  },

  async recordFeedback(payload: QuestionFeedbackPayload): Promise<any> {
    return requestBackend('/api/questions/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getCustomKnowledge(): Promise<CustomKnowledgeItem[]> {
    return requestBackend('/api/questions/custom-knowledge');
  },

  async saveCustomKnowledge(content: string, topic?: string): Promise<CustomKnowledgeItem> {
    return requestBackend('/api/questions/custom-knowledge', {
      method: 'POST',
      body: JSON.stringify({ content, topic: topic || 'General' }),
    });
  },

  async deleteCustomKnowledge(id: string): Promise<{ success: boolean }> {
    return requestBackend(`/api/questions/custom-knowledge/${id}`, {
      method: 'DELETE',
    });
  },
};

