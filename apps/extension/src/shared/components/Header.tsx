import React from 'react';
import {
  Cpu,
  Settings,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ExternalLink,
  Minimize2,
  Maximize2,
  PanelRight,
} from 'lucide-react';

interface HeaderProps {
  backendOnline: boolean;
  geminiConfigured: boolean;
  onOpenSettings: () => void;
  onRefresh: () => void;
  isRefreshing?: boolean;
  isCompact?: boolean;
  onToggleCompact?: () => void;
  onPopOut?: () => void;
  isStandalone?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  backendOnline,
  geminiConfigured,
  onOpenSettings,
  onRefresh,
  isRefreshing,
  isCompact,
  onToggleCompact,
  onPopOut,
  isStandalone,
}) => {
  const handleOpenSidePanel = () => {
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    } catch (e) {
      console.warn('Could not send OPEN_SIDEPANEL:', e);
    }
  };
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
          <Cpu className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-sm font-semibold text-slate-900 leading-tight">AI MCQ Assistant</h1>
          <p className="text-[11px] text-slate-500">Local Practice Tutor</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium ${
              backendOnline
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-rose-50 text-rose-700 border border-rose-200'
            }`}
            title={backendOnline ? 'Backend Online (127.0.0.1:3000)' : 'Backend Offline'}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                backendOnline ? 'bg-emerald-500' : 'bg-rose-500'
              }`}
            />
            {backendOnline ? 'Backend' : 'Offline'}
          </span>

          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium ${
              geminiConfigured
                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                : 'bg-amber-50 text-amber-700 border border-amber-200'
            }`}
            title={geminiConfigured ? 'Gemini Ready' : 'Gemini Key Needed'}
          >
            {geminiConfigured ? (
              <CheckCircle2 className="h-3 w-3 text-blue-600" />
            ) : (
              <AlertCircle className="h-3 w-3 text-amber-600" />
            )}
            AI
          </span>
        </div>

        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          title="Refresh Detection"
        >
          <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-blue-600' : ''}`} />
        </button>

        {onToggleCompact && (
          <button
            onClick={onToggleCompact}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
            title={isCompact ? 'Restore standard size' : 'Reduce size (Compact mode)'}
          >
            {isCompact ? <Maximize2 className="h-4 w-4 text-indigo-600" /> : <Minimize2 className="h-4 w-4" />}
          </button>
        )}

        {!isStandalone && onPopOut && (
          <button
            onClick={onPopOut}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600 transition"
            title="Pop out into draggable desktop window"
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        )}

        <button
          onClick={handleOpenSidePanel}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 transition"
          title="Open in Chrome Side Panel"
        >
          <PanelRight className="h-4 w-4" />
        </button>

        <button
          onClick={onOpenSettings}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          title="Settings / API Key"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
};

