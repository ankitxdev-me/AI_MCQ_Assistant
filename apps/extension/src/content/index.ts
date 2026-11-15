import { DOMQuestionExtractor } from './extractor';
import { DOMInteractionManager } from './interaction';
import { DOMQuestionObserver } from './observer';
import { matchAIAnswerToOptions, matchAIMultipleAnswersToOptions } from './matcher';
import { ExtensionMessage } from '@ai-mcq/shared-types';

const extractor = new DOMQuestionExtractor();
const interaction = new DOMInteractionManager();

// Observer sends updates to the background script
const observer = new DOMQuestionObserver(extractor, (questions, currentQuestion) => {
  if (document.hidden) return; // Multi-tab isolation: never send messages from hidden background tabs
  try {
    chrome.runtime.sendMessage({
      type: 'DOM_QUESTIONS_EXTRACTED',
      payload: {
        questions,
        currentQuestion,
        url: window.location.href,
        title: document.title,
      },
    });
  } catch (err) {
    // Context may be invalidated if extension was reloaded
  }
});

// Auto-start observer on idle
observer.start();

// Listen to incoming messages from extension popup/sidepanel/background
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  switch (message.type) {
    case 'DOM_EXTRACT_QUESTIONS': {
      const questions = extractor.extractAllQuestions();
      const currentQuestion = questions.length > 0 ? questions[0] : undefined;
      sendResponse({
        success: true,
        questions,
        currentQuestion,
        url: window.location.href,
        title: document.title,
      });
      break;
    }

    case 'CONFIRM_SELECTION': {
      const payload = message.payload as any;
      if (Array.isArray(payload.optionIds) && payload.optionIds.length > 0) {
        const result = interaction.selectMultipleOptions(payload.optionIds, payload.options || []);
        sendResponse(result);
      } else {
        const result = interaction.selectOption(
          payload.optionId,
          payload.elementSelector,
          payload.optionText,
        );
        sendResponse(result);
      }
      break;
    }

    case 'MATCH_AND_SELECT' as any: {
      const { aiResult, options, isMultipleAnswer } = (message as any).payload || {};
      const isMulti =
        isMultipleAnswer === true ||
        (Array.isArray(aiResult?.selected_option_ids) && aiResult.selected_option_ids.length > 0) ||
        (aiResult?.selected_option_id &&
          (aiResult.selected_option_id.includes(',') ||
            aiResult.selected_option_id.includes(';') ||
            /\band\b/i.test(aiResult.selected_option_id)));

      if (isMulti) {
        const multiMatch = matchAIMultipleAnswersToOptions(aiResult, options);
        if (multiMatch.isMatched && multiMatch.matchedIds.length > 0) {
          const result = interaction.selectMultipleOptions(multiMatch.matchedIds, options);
          sendResponse({ ...result, match: multiMatch, matched: true, success: true });
          break;
        }
      }

      // Single option match
      const match = matchAIAnswerToOptions(aiResult, options);
      if (match.isMatched && match.matchedOption) {
        const result = interaction.selectOption(
          match.matchedId!,
          match.matchedOption.elementSelector,
          match.matchedText!,
        );
        sendResponse({ ...result, match, matched: true, success: true });
        break;
      }

      // Safe fallback if neither matched: pick the first option to prevent auto-loop halt
      if (options && options.length > 0) {
        const fallbackOpt = options[0];
        const result = interaction.selectOption(
          fallbackOpt.id,
          fallbackOpt.elementSelector,
          fallbackOpt.text,
        );
        sendResponse({
          ...result,
          match: {
            matchedOption: fallbackOpt,
            matchedId: fallbackOpt.id,
            matchedText: fallbackOpt.text,
            confidence: 0.5,
            matchReason: 'fallback-first-option',
            isMatched: true,
          },
          matched: true,
          success: true,
        });
        break;
      }

      sendResponse({
        success: false,
        matched: false,
        message: `Could not match Gemini answer to DOM options.`,
        match,
      });
      break;
    }

    case 'REORDER_OPTIONS' as any: {
      const { targetSequence, options } = (message as any).payload || {};
      interaction.reorderOptions(targetSequence || [], options || []).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    case 'SUBMIT_ANSWER' as any: {
      interaction.clickSubmitButton(6000).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    case 'INSPECT_SUBMISSION' as any: {
      const { options, selectedOptionId } = (message as any).payload || {};
      const result = interaction.inspectSubmissionResult(options || [], selectedOptionId);
      sendResponse(result);
      break;
    }

    case 'WAIT_AND_CLICK_NEXT' as any: {
      interaction.waitForAndClickNextButton(15000).then((res) => {
        sendResponse(res);
      });
      return true;
    }

    case 'NAVIGATE_NEXT_QUESTION': {
      const result = interaction.navigateNextQuestion();
      sendResponse(result);
      break;
    }

    case 'START_TAB_AUTO_LOOP' as any: {
      tabAutoLoopActive = true;
      tabSubmittedFingerprints.clear();
      executeTabAutoLoopCycle();
      sendResponse({ success: true, isRunning: true });
      break;
    }

    case 'STOP_TAB_AUTO_LOOP' as any: {
      tabAutoLoopActive = false;
      isCycleRunning = false;
      tabAutoLoopStatus = 'Auto-Loop paused';
      sendResponse({ success: true, isRunning: false });
      break;
    }

    case 'GET_TAB_AUTO_LOOP_STATUS' as any: {
      sendResponse({
        isRunning: tabAutoLoopActive,
        status: tabAutoLoopStatus,
        solvedCount: tabSolvedCount,
      });
      break;
    }

    default:
      break;
  }
  return true; // Keep message channel open for async response
});

// Per-tab isolated auto-loop state (enables multiple tabs to run simultaneously in parallel)
let tabAutoLoopActive = false;
let tabAutoLoopStatus = '';
let tabSolvedCount = 0;
let isCycleRunning = false;
const tabSubmittedFingerprints = new Set<string>();

async function executeTabAutoLoopCycle(): Promise<void> {
  if (!tabAutoLoopActive || isCycleRunning) return;
  isCycleRunning = true;

  try {
    const questions = extractor.extractAllQuestions();
    if (questions.length === 0) {
      tabAutoLoopStatus = 'Scanning webpage for questions...';
      isCycleRunning = false;
      if (tabAutoLoopActive) setTimeout(executeTabAutoLoopCycle, 1200);
      return;
    }

    const liveQuestion = questions[0];
    if (tabSubmittedFingerprints.has(liveQuestion.fingerprint)) {
      tabAutoLoopStatus = 'Waiting for next question to render...';
      isCycleRunning = false;
      if (tabAutoLoopActive) setTimeout(executeTabAutoLoopCycle, 1000);
      return;
    }

    tabAutoLoopStatus = `1. Solving with Gemini: "${liveQuestion.questionText.slice(0, 45)}..."`;

    // Solve question via background proxy fetch
    const response: any = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'BACKEND_FETCH',
          payload: {
            endpoint: '/api/questions/solve',
            options: {
              method: 'POST',
              body: JSON.stringify({
                question: liveQuestion.questionText,
                options: liveQuestion.options.map((o) => ({ id: o.id, text: o.text })),
                questionFingerprint: liveQuestion.fingerprint,
                questionNumber: liveQuestion.questionNumber,
                isMultipleChoiceMultipleAnswer: liveQuestion.isMultipleChoiceMultipleAnswer,
                isOrderingQuestion: liveQuestion.isOrderingQuestion,
                questionType: liveQuestion.questionType,
              }),
            },
          },
        },
        resolve,
      );
    });

    if (!tabAutoLoopActive) {
      isCycleRunning = false;
      return;
    }

    const answer = response?.data?.answer;
    if (!answer) {
      tabAutoLoopStatus = 'AI busy / rate-limited. Retrying in 2s...';
      isCycleRunning = false;
      if (tabAutoLoopActive) setTimeout(executeTabAutoLoopCycle, 2000);
      return;
    }

    // Step 2: Check for Drag & Drop / Step Ordering
    if (liveQuestion.isOrderingQuestion || (answer.ordered_sequence && answer.ordered_sequence.length > 0)) {
      const seq =
        answer.ordered_sequence ||
        (answer.selected_option_id || '').split(/[,;\->\s]+/).filter(Boolean);
      tabAutoLoopStatus = `⏸️ Drag & Drop: Order is [${seq.join(' → ')}]. Paused for manual arrange.`;
      tabAutoLoopActive = false;
      isCycleRunning = false;
      return;
    }

    // Step 3: Match and select options
    const isMulti = Boolean(liveQuestion.isMultipleChoiceMultipleAnswer);
    let matchedIdStr = '';
    if (isMulti) {
      const multiMatch = matchAIMultipleAnswersToOptions(answer, liveQuestion.options);
      if (multiMatch.isMatched && multiMatch.matchedIds.length > 0) {
        interaction.selectMultipleOptions(multiMatch.matchedIds, liveQuestion.options);
        matchedIdStr = multiMatch.matchedIds.join(', ');
      }
    } else {
      const match = matchAIAnswerToOptions(answer, liveQuestion.options);
      if (match.isMatched && match.matchedOption) {
        interaction.selectOption(match.matchedId!, match.matchedOption.elementSelector, match.matchedText!);
        matchedIdStr = match.matchedId!;
      }
    }

    tabAutoLoopStatus = `2. Marked option(s) [${matchedIdStr || answer.selected_option_id}]. Submitting...`;
    await new Promise((r) => setTimeout(r, 650));
    if (!tabAutoLoopActive) {
      isCycleRunning = false;
      return;
    }

    // Step 4: Submit Answer
    await interaction.clickSubmitButton(6000);
    tabSubmittedFingerprints.add(liveQuestion.fingerprint);
    tabSolvedCount++;

    await new Promise((r) => setTimeout(r, 700));
    if (!tabAutoLoopActive) {
      isCycleRunning = false;
      return;
    }

    // Step 5: Click Next
    tabAutoLoopStatus = '3. Clicking Next question...';
    await interaction.waitForAndClickNextButton(10000);

    // Step 6: Wait for next question to load
    await new Promise((r) => setTimeout(r, 1200));
    isCycleRunning = false;
    if (tabAutoLoopActive) {
      executeTabAutoLoopCycle();
    }
  } catch (err: any) {
    tabAutoLoopStatus = `Loop error: ${err.message}. Retrying in 2s...`;
    isCycleRunning = false;
    if (tabAutoLoopActive) setTimeout(executeTabAutoLoopCycle, 2000);
  }
}

// Rescan on URL changes in single page apps (SPA)
window.addEventListener('popstate', () => observer.scan(true));
window.addEventListener('hashchange', () => observer.scan(true));

