import React from 'react';
import {
  PracticeSession,
  ExtractedQuestion,
  AIAnswerResult,
} from '@ai-mcq/shared-types';
import { QuestionCard } from './QuestionCard';
import { CustomKnowledgeCard } from './CustomKnowledgeCard';
import {
  Play,
  Pause,
  Square,
  BarChart2,
  Globe,
  HelpCircle,
  FileText,
  AlertCircle,
  Zap,
} from 'lucide-react';

interface MainScreenProps {
  session: PracticeSession | null;
  activeTabInfo: { url?: string; title?: string } | null;
  detectedQuestions: ExtractedQuestion[];
  activeQuestionIndex: number;
  setActiveQuestionIndex: (idx: number) => void;
  onStartSession: () => void;
  onPauseSession: () => void;
  onResumeSession: () => void;
  onStopSession: () => void;
  onViewResults: () => void;
  onSolveQuestion: (q: ExtractedQuestion) => Promise<void>;
  onConfirmSelection: (optionId: string, elementSelector?: string, optionText?: string) => Promise<void>;
  onReorder?: (targetSequence: string[]) => Promise<void>;
  onSubmitAnswer?: () => Promise<void>;
  onNextQuestion: () => Promise<void>;
  onResetSession?: () => void;
  isSolving: boolean;
  autoPilot?: boolean;
  autoPilotStatus?: string;
  onToggleAutoPilot?: () => void;
}

export const MainScreen: React.FC<MainScreenProps> = ({
  session,
  activeTabInfo,
  detectedQuestions,
  activeQuestionIndex,
  setActiveQuestionIndex,
  onStartSession,
  onPauseSession,
  onResumeSession,
  onStopSession,
  onViewResults,
  onSolveQuestion,
  onConfirmSelection,
  onReorder,
  onSubmitAnswer,
  onNextQuestion,
  onResetSession,
  isSolving,
  autoPilot = false,
  autoPilotStatus = '',
  onToggleAutoPilot,
}) => {
  const isSessionActive = session && session.status === 'ACTIVE';
  const isSessionPaused = session && session.status === 'PAUSED';

  // Prefer live questions currently detected on the active webpage
  const questionsToDisplay =
    detectedQuestions && detectedQuestions.length > 0
      ? detectedQuestions
      : session?.questions || [];

  const currentQuestion = questionsToDisplay[activeQuestionIndex] || questionsToDisplay[0];

  return (
    <div className="flex flex-col flex-1 bg-slate-50 overflow-y-auto p-3.5 pb-36">
      {/* Active Page Info Card */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm mb-4">
        <div className="flex items-center gap-2 text-slate-500 text-[11px] mb-1">
          <Globe className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
          <span className="font-medium truncate">
            {activeTabInfo?.url
              ? new URL(activeTabInfo.url).hostname
              : 'Unknown Domain'}
          </span>
        </div>
        <div className="text-xs font-semibold text-slate-800 truncate" title={activeTabInfo?.title}>
          {activeTabInfo?.title || 'No active portal detected'}
        </div>
      </div>

      {/* Auto-Pilot Status Banner */}
      {autoPilot && (
        <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs shadow-sm flex items-center gap-2.5">
          <Zap className="h-4 w-4 text-amber-600 flex-shrink-0 animate-pulse fill-amber-500" />
          <div className="flex-1 font-medium leading-tight">
            {autoPilotStatus || 'Auto-Loop running: solving, marking, submitting...'}
          </div>
        </div>
      )}

      {/* Custom Knowledge Base Input & Cheatsheet Card */}
      <CustomKnowledgeCard defaultTopic={activeTabInfo?.title} />

      {/* Session Controls & Stats Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-3.5 shadow-sm mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">
              Practice Session
            </div>
            <div className="text-sm font-bold text-slate-900 mt-0.5">
              {session ? `Status: ${session.status}` : 'Ready to Start'}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {onToggleAutoPilot && (
              <button
                onClick={onToggleAutoPilot}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition shadow-sm ${
                  autoPilot
                    ? 'bg-amber-500 text-white hover:bg-amber-600 animate-pulse'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700'
                }`}
                title={autoPilot ? 'Click to Stop Auto-Pilot' : 'Automatically Solve, Mark, Submit, and Next in a Loop'}
              >
                <Zap className="h-3.5 w-3.5 fill-current" />
                {autoPilot ? 'Auto: ON' : 'Auto-Loop'}
              </button>
            )}

            {!session || session.status === 'STOPPED' ? (
              <button
                onClick={onStartSession}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition shadow-sm"
              >
                <Play className="h-3.5 w-3.5 fill-current" /> Start
              </button>
            ) : (
              <>
                {isSessionActive && (
                  <button
                    onClick={onPauseSession}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 transition"
                    title="Pause Session"
                  >
                    <Pause className="h-3.5 w-3.5" />
                  </button>
                )}

                {isSessionPaused && (
                  <button
                    onClick={onResumeSession}
                    className="p-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition"
                    title="Resume Session"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </button>
                )}

                <button
                  onClick={onStopSession}
                  className="p-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 transition"
                  title="Stop Session"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>

                <button
                  onClick={onViewResults}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 text-xs font-medium hover:bg-slate-50 transition"
                  title="View Results"
                >
                  <BarChart2 className="h-3.5 w-3.5" /> Summary
                </button>
              </>
            )}
          </div>
        </div>

        {/* Question Counter / Pills */}
        <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
          <span className="text-slate-500">
            Active: <strong className="text-slate-800">{questionsToDisplay.length}</strong> {questionsToDisplay.length === 1 ? 'question' : 'questions'}
          </span>
          <div className="flex items-center gap-2">
            {session && (
              <span className="text-slate-500">
                Solved: <strong className="text-blue-600">{session.processedCount}</strong> /{' '}
                {session.totalDetected}
              </span>
            )}
            {onResetSession && (session || questionsToDisplay.length > 1) && (
              <button
                onClick={onResetSession}
                className="text-[10px] text-slate-400 hover:text-rose-600 transition underline cursor-pointer"
                title="Clear question history"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Question Selector Carousel / Stepper Tabs */}
      {questionsToDisplay.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2 mb-3 scrollbar-thin">
          {questionsToDisplay.map((q, idx) => {
            const isCurrent = idx === activeQuestionIndex;
            const hasAns = !!q.aiAnswer;
            return (
              <button
                key={q.fingerprint || idx}
                onClick={() => setActiveQuestionIndex(idx)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition flex items-center gap-1 ${
                  isCurrent
                    ? 'bg-blue-600 text-white shadow-sm'
                    : hasAns
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span>Q{idx + 1}</span>
                {hasAns && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              </button>
            );
          })}
        </div>
      )}

      {/* Main Question View */}
      {currentQuestion ? (
        <QuestionCard
          question={currentQuestion}
          onSolve={onSolveQuestion}
          onConfirmSelection={onConfirmSelection}
          onReorder={onReorder}
          onSubmitAnswer={onSubmitAnswer}
          onNextQuestion={onNextQuestion}
          isSolving={isSolving}
          totalQuestions={questionsToDisplay.length}
          currentIndex={activeQuestionIndex + 1}
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center my-auto shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600 mb-3">
            <HelpCircle className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-slate-900 mb-1">
            No MCQ Detected Yet
          </h3>
          <p className="text-xs text-slate-500 max-w-xs mx-auto mb-3">
            If you opened this tab before installing the extension, simply <strong>refresh this webpage (press F5)</strong> so Chrome can inspect it.
          </p>
          {activeTabInfo?.url?.startsWith('file://') && (
            <div className="text-[11px] bg-amber-50 border border-amber-200 text-amber-800 p-2.5 rounded-lg mb-3 text-left">
              <strong>Local file:// detected:</strong> Chrome requires you to enable <em>"Allow access to file URLs"</em> in <code>chrome://extensions</code> &rarr; Details, or open via local URL:
              <div className="mt-1 font-mono text-[10px] bg-white p-1 rounded border border-amber-200 break-all select-all">
                http://127.0.0.1:3000/test-portal
              </div>
            </div>
          )}
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-100 text-slate-600 text-xs">
            <FileText className="h-3.5 w-3.5" />
            Supports standard forms, labels, & ARIA radiogroups
          </div>
        </div>
      )}
    </div>
  );
};

