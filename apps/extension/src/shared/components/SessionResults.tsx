import React from 'react';
import { PracticeSession } from '@ai-mcq/shared-types';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Layers,
  ArrowLeft,
  RotateCcw,
} from 'lucide-react';

interface SessionResultsProps {
  session: PracticeSession;
  onNewSession: () => void;
  onBackToQuestions: () => void;
}

export const SessionResults: React.FC<SessionResultsProps> = ({
  session,
  onNewSession,
  onBackToQuestions,
}) => {
  const formatDuration = () => {
    const start = new Date(session.startTime).getTime();
    const end = session.endTime ? new Date(session.endTime).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    const mins = Math.floor(seconds / 60);
    const remainingSecs = seconds % 60;
    return `${mins}m ${remainingSecs}s`;
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-slate-50 overflow-y-auto p-4 pb-8">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={onBackToQuestions}
          className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Session
        </button>
        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-slate-200 text-slate-800">
          Status: {session.status}
        </span>
      </div>

      <h2 className="text-base font-semibold text-slate-900 mb-3">Session Summary</h2>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 gap-2.5 mb-4">
        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <Layers className="h-4 w-4 text-blue-600" />
            <span>Total Questions</span>
          </div>
          <div className="text-xl font-bold text-slate-900">{session.totalDetected}</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>Solved</span>
          </div>
          <div className="text-xl font-bold text-emerald-600">{session.processedCount}</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span>Needs Review</span>
          </div>
          <div className="text-xl font-bold text-amber-600">{session.needsReviewCount}</div>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
            <Clock className="h-4 w-4 text-slate-600" />
            <span>Duration</span>
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">{formatDuration()}</div>
        </div>
      </div>

      {/* History List */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4 flex-1">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-3">
          Question Breakdown
        </h3>

        {session.questions.length === 0 ? (
          <p className="text-xs text-slate-400 italic text-center py-4">
            No questions recorded for this session.
          </p>
        ) : (
          <div className="space-y-2">
            {session.questions.map((q, idx) => (
              <div
                key={q.fingerprint || idx}
                className="p-2.5 rounded-lg border border-slate-100 bg-slate-50 text-xs flex items-start justify-between gap-2"
              >
                <div className="flex-1">
                  <div className="font-medium text-slate-800 line-clamp-2">
                    {idx + 1}. {q.questionText}
                  </div>
                  {q.aiAnswer && (
                    <div className="text-[11px] text-blue-700 mt-1">
                      Picked: <span className="font-semibold">{q.aiAnswer.selected_option_id}</span> ({q.aiAnswer.answer_text})
                    </div>
                  )}
                </div>

                <div className="flex-shrink-0">
                  {q.status === 'COMPLETED' ? (
                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                      Completed
                    </span>
                  ) : q.status === 'ANSWER_READY' ? (
                    <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                      Answer Ready
                    </span>
                  ) : q.status === 'NEEDS_REVIEW' ? (
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                      Review
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded">
                      {q.status}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onNewSession}
        className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg bg-blue-600 text-white font-medium text-xs hover:bg-blue-700 transition shadow-sm"
      >
        <RotateCcw className="h-4 w-4" /> Start New Practice Session
      </button>
    </div>
  );
};

