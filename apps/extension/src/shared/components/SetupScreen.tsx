import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound, CheckCircle2, AlertTriangle, ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import { ApiClient } from '../api';
import { ConfigStatusResponse } from '@ai-mcq/shared-types';

interface SetupScreenProps {
  configStatus: ConfigStatusResponse | null;
  onConfigSaved: () => void;
  onCancel?: () => void;
}

export const SetupScreen: React.FC<SetupScreenProps> = ({
  configStatus,
  onConfigSaved,
  onCancel,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(configStatus?.model || 'gemini-1.5-flash');
  const [showKey, setShowKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    setErrorMsg(null);
    try {
      const res = await ApiClient.testConnection(apiKey.trim() || undefined, model);
      setTestResult({
        success: res.success,
        message: res.message,
      });
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || 'Connection test failed',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() && !configStatus?.hasEnvFallback) {
      setErrorMsg('Please enter your Gemini API key');
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);
    try {
      await ApiClient.saveGeminiConfig(apiKey.trim(), model);
      onConfigSaved();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to save configuration');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-50 overflow-y-auto p-4 pb-8">
      <div className="flex items-center justify-between mb-4">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        )}
        <h2 className="text-base font-semibold text-slate-900 flex items-center gap-1.5">
          <KeyRound className="h-4 w-4 text-blue-600" />
          API Configuration
        </h2>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm mb-4">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Google Gemini Setup</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Enter your Gemini API key to power instant, structured MCQ problem-solving.
            </p>
          </div>
        </div>

        {configStatus?.configured && (
          <div className="mb-4 p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
            <div>
              <span className="font-semibold">Active configuration detected:</span> Source:{' '}
              {configStatus.source} ({configStatus.model})
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              AI Provider
            </label>
            <input
              type="text"
              disabled
              value="Google Gemini"
              className="w-full text-xs rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-slate-600 cursor-not-allowed"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-700">
                Gemini API Key
              </label>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-blue-600 hover:underline"
              >
                Get API Key
              </a>
            </div>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                placeholder={configStatus?.configured ? '••••••••••••••••••••••••' : 'AIzaSy...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full text-xs rounded-lg border border-slate-300 px-3 py-2 pr-9 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              Your key is stored strictly on your local computer SQLite database and never leaves localhost.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Model Selection
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full text-xs rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {(configStatus?.availableModels || [
                'gemini-1.5-flash',
                'gemini-1.5-pro',
                'gemini-2.0-flash',
                'gemini-2.5-flash',
              ]).map((m) => (
                <option key={m} value={m}>
                  {m} {m === 'gemini-1.5-flash' ? '(Recommended - Fast & Accurate)' : ''}
                </option>
              ))}
            </select>
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-500 flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {testResult && (
            <div
              className={`p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                testResult.success
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border border-rose-200 text-rose-700'
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-rose-500 flex-shrink-0" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={isTesting}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
            >
              {isTesting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </button>

            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50 shadow-sm"
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Settings'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

