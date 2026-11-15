import React, { useState } from 'react';
import {
  ExtractedQuestion,
  AIAnswerResult,
} from '@ai-mcq/shared-types';
import {
  CheckCircle,
  HelpCircle,
  AlertCircle,
  MousePointerClick,
  ArrowRight,
  Sparkles,
  Loader2,
  RefreshCw,
  Globe,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface QuestionCardProps {
  question: ExtractedQuestion & { aiAnswer?: AIAnswerResult; userConfirmedSelection?: string };
  onSolve: (question: ExtractedQuestion) => Promise<void>;
  onConfirmSelection: (optionId: string, elementSelector?: string, optionText?: string) => Promise<void>;
  onReorder?: (targetSequence: string[]) => Promise<void>;
  onSubmitAnswer?: () => Promise<void>;
  onNextQuestion: () => Promise<void>;
  isSolving?: boolean;
  totalQuestions?: number;
  currentIndex?: number;
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
  question,
  onSolve,
  onConfirmSelection,
  onReorder,
  onSubmitAnswer,
  onNextQuestion,
  isSolving,
  totalQuestions = 1,
  currentIndex = 1,
}) => {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [showWebEvidence, setShowWebEvidence] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const aiAnswer = question.aiAnswer;

  const handleConfirm = async (optionId: string, selector?: string, text?: string) => {
    setIsConfirming(true);
    setFeedback(null);
    try {
      await onConfirmSelection(optionId, selector, text);
      setFeedback(`Selection confirmed for option ${optionId}`);
    } catch (err: any) {
      setFeedback(`Failed to select option: ${err.message}`);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleSubmit = async () => {
    if (!onSubmitAnswer) return;
    setIsSubmitting(true);
    setFeedback(null);
    try {
      await onSubmitAnswer();
      setFeedback('Clicked Submit on webpage');
    } catch (err: any) {
      setFeedback(`Submit error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleNext = async () => {
    setIsNavigating(true);
    try {
      await onNextQuestion();
    } catch (err: any) {
      setFeedback(`Could not advance: ${err.message}`);
    } finally {
      setIsNavigating(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-4">
      {/* Header bar */}
      <div className="bg-slate-50 border-b border-slate-200 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
            Q{question.questionNumber || currentIndex} of {totalQuestions}
          </span>
          {question.isOrderingQuestion ? (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-200">
              ⇅ Drag & Drop Ordering
            </span>
          ) : question.isMultipleChoiceMultipleAnswer ? (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200">
              ☑ Multi-Answer MCQ (Squares)
            </span>
          ) : (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
              ◉ Single-Choice MCQ
            </span>
          )}
          <span className="text-[11px] text-slate-500 font-mono">
            {question.extractionStrategy}
          </span>
        </div>

        {aiAnswer && (
          <div className="flex items-center gap-1.5 text-xs">
            {aiAnswer.needs_review ? (
              <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-[11px] font-medium">
                <AlertCircle className="h-3 w-3" /> Needs Review
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 text-[11px] font-medium">
                <CheckCircle className="h-3 w-3" /> {(aiAnswer.confidence * 100).toFixed(0)}% Confidence
              </span>
            )}
          </div>
        )}
      </div>

      <div className="p-4 space-y-4">
        {/* Question Text & Search Link */}
        <div>
          <h3 className="text-sm font-medium text-slate-900 leading-relaxed mb-1.5">
            {question.questionText}
          </h3>
          <div className="flex items-center gap-2">
            <a
              href={`https://www.google.com/search?q=${encodeURIComponent(question.questionText)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 hover:underline font-medium"
              title="Search this exact question on Google in a new tab"
            >
              <Globe className="h-3 w-3" />
              <span>Search on Google</span>
              <ExternalLink className="h-2.5 w-2.5 opacity-70" />
            </a>
          </div>
        </div>

        {/* Options List with independent scrolling */}
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1 pb-1 scrollbar-thin">
          {question.options.map((opt) => {
            const isOrdering = Boolean(question.isOrderingQuestion);
            const seq =
              aiAnswer?.ordered_sequence ||
              (aiAnswer?.selected_option_id || '')
                .split(/[,;\->\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            const orderIndex = isOrdering ? seq.indexOf(opt.id) : -1;

            const selectedList =
              aiAnswer?.selected_option_ids && aiAnswer.selected_option_ids.length > 0
                ? aiAnswer.selected_option_ids
                : (aiAnswer?.selected_option_id || '')
                    .split(/[,;\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean);
            const isRecommended = isOrdering
              ? orderIndex >= 0
              : selectedList.includes(opt.id) || aiAnswer?.selected_option_id === opt.id;
            const confirmedList = (question.userConfirmedSelection || '')
              .split(/[,;\s]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            const isUserConfirmed = confirmedList.includes(opt.id) || question.userConfirmedSelection === opt.id;

            let borderClass = 'border-slate-200 hover:border-slate-300 bg-white';
            let badgeClass = 'bg-slate-100 text-slate-700';

            if (isRecommended) {
              borderClass = isOrdering
                ? 'border-indigo-500 bg-indigo-50/50 ring-1 ring-indigo-500'
                : 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500';
              badgeClass = isOrdering ? 'bg-indigo-600 text-white' : 'bg-blue-600 text-white';
            }

            if (isUserConfirmed) {
              borderClass = 'border-emerald-500 bg-emerald-50/50 ring-1 ring-emerald-500';
              badgeClass = 'bg-emerald-600 text-white';
            }

            // Square checkboxes for multi-answer, circular for single-choice
            const shapeClass = question.isMultipleChoiceMultipleAnswer ? 'rounded-md' : 'rounded-full';

            return (
              <div
                key={opt.id}
                onClick={() => handleConfirm(opt.id, opt.elementSelector, opt.text)}
                className={`flex items-start gap-3 p-2.5 rounded-lg border text-xs transition cursor-pointer ${borderClass}`}
                title={isOrdering ? 'Ordering step' : 'Click to select this option on the webpage'}
              >
                <div
                  className={`flex h-5 w-5 flex-shrink-0 items-center justify-center font-bold text-[10px] ${shapeClass} ${badgeClass}`}
                >
                  {opt.id}
                </div>
                <div className="flex-1 text-slate-800 leading-normal font-normal">
                  {opt.text}
                </div>
                {isOrdering && orderIndex >= 0 && (
                  <span className="text-[10px] font-semibold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded font-mono">
                    Step {orderIndex + 1}
                  </span>
                )}
                {!isOrdering && isRecommended && (
                  <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                    AI Pick
                  </span>
                )}
                {isUserConfirmed && (
                  <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                    Confirmed
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* AI Answer & Explanation Card */}
        {aiAnswer ? (
          <div className="rounded-lg bg-blue-50/70 border border-blue-200 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                {question.isOrderingQuestion
                  ? `Recommended Order: ${(aiAnswer.ordered_sequence || [aiAnswer.selected_option_id]).join(' → ')}`
                  : question.isMultipleChoiceMultipleAnswer
                  ? `Recommended: Options ${aiAnswer.selected_option_id}`
                  : `Recommended: Option ${aiAnswer.selected_option_id}`}
              </span>
              <button
                onClick={() => onSolve(question)}
                disabled={isSolving}
                className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center gap-1 disabled:opacity-50"
                title="Re-run AI solver"
              >
                <RefreshCw className={`h-3 w-3 ${isSolving ? 'animate-spin' : ''}`} />
                Re-solve
              </button>
            </div>

            <p className="text-xs text-slate-700 leading-relaxed font-sans">
              {aiAnswer.explanation}
            </p>

            {aiAnswer.reasoning && (
              <p className="text-[11px] text-slate-500 italic border-t border-blue-200/60 pt-1.5">
                Note: {aiAnswer.reasoning}
              </p>
            )}

            {aiAnswer.webEvidence && aiAnswer.webEvidence.length > 0 && (
              <div className="border-t border-blue-200/60 pt-1.5">
                <button
                  type="button"
                  onClick={() => setShowWebEvidence((prev) => !prev)}
                  className="flex items-center justify-between w-full text-[11px] font-semibold text-blue-800 hover:text-blue-950 py-0.5"
                >
                  <span className="flex items-center gap-1.5">
                    <Globe className="h-3 w-3 text-blue-600" />
                    Web Search Evidence ({aiAnswer.webEvidence.length} sources found)
                  </span>
                  {showWebEvidence ? (
                    <ChevronUp className="h-3 w-3 text-blue-500" />
                  ) : (
                    <ChevronDown className="h-3 w-3 text-blue-500" />
                  )}
                </button>
                {showWebEvidence && (
                  <div className="mt-1.5 space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {aiAnswer.webEvidence.map((snippet, idx) => (
                      <div
                        key={idx}
                        className="text-[10px] text-slate-700 bg-white/90 border border-blue-100 p-1.5 rounded leading-relaxed whitespace-pre-wrap select-text"
                      >
                        {snippet}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="pt-2">
            <button
              onClick={() => onSolve(question)}
              disabled={isSolving}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-lg bg-blue-600 text-white font-medium text-xs hover:bg-blue-700 transition shadow-sm disabled:opacity-50"
            >
              {isSolving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching Web & Solving with Gemini...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Search Web & Solve with Gemini
                </>
              )}
            </button>
          </div>
        )}

        {/* Feedback message */}
        {feedback && (
          <div className="text-[11px] text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded text-center">
            {feedback}
          </div>
        )}

        {/* Action Controls */}
        {aiAnswer && (
          <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
            {question.isOrderingQuestion ? (
              <button
                onClick={async () => {
                  const seq =
                    aiAnswer.ordered_sequence ||
                    (aiAnswer.selected_option_id || '').split(/[,;\->\s]+/).map((s) => s.trim()).filter(Boolean);
                  setIsConfirming(true);
                  setFeedback(null);
                  try {
                    if (onReorder) {
                      await onReorder(seq);
                    } else {
                      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                      if (tab?.id) {
                        const res: any = await chrome.tabs.sendMessage(tab.id, {
                          type: 'REORDER_OPTIONS',
                          payload: { targetSequence: seq, options: question.options },
                        });
                        setFeedback(res?.message || 'Reordered items on page');
                      }
                    }
                  } catch (err: any) {
                    setFeedback(`Reorder error: ${err.message}`);
                  } finally {
                    setIsConfirming(false);
                  }
                }}
                disabled={isConfirming}
                className="flex-1 min-w-[140px] flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50"
              >
                {isConfirming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MousePointerClick className="h-3.5 w-3.5" />
                )}
                1. Arrange in Correct Order
              </button>
            ) : (
              <button
                onClick={() => {
                  const opt = question.options.find(
                    (o) => o.id === aiAnswer.selected_option_id,
                  );
                  handleConfirm(aiAnswer.selected_option_id, opt?.elementSelector, opt?.text);
                }}
                disabled={isConfirming}
                className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition disabled:opacity-50"
              >
                {isConfirming ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <MousePointerClick className="h-3.5 w-3.5" />
                )}
                {question.isMultipleChoiceMultipleAnswer
                  ? `1. Mark Options (${aiAnswer.selected_option_id})`
                  : `1. Mark Option (${aiAnswer.selected_option_id})`}
              </button>
            )}

            {onSubmitAnswer && (
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition disabled:opacity-50"
                title="Click Submit on the portal"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  '2. Submit'
                )}
              </button>
            )}

            <button
              onClick={handleNext}
              disabled={isNavigating}
              className="flex items-center justify-center gap-1 py-2 px-3 rounded-lg border border-slate-300 text-slate-700 text-xs font-medium hover:bg-slate-50 transition disabled:opacity-50"
              title="Click Next on the portal"
            >
              {isNavigating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  3. Next <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

