import { DOMQuestionExtractor, VISUAL_PLACEHOLDER_PROMPT } from './extractor';
import { DOMInteractionManager } from './interaction';
import { DOMQuestionObserver } from './observer';
import { matchAIAnswerToOptions, matchAIMultipleAnswersToOptions } from './matcher';
import { buildMediaRequest, regionScreenshotRect, ResolvedMedia } from './media';
import { sleep } from './timing';
import { ExtensionMessage, ExtractedQuestion } from '@ai-mcq/shared-types';

/**
 * The side panel injects this file again when it gets no answer from the tab. Two live copies
 * in one tab meant two Auto-Loops answering the same question. Only one live copy may run;
 * a copy orphaned by an extension reload (its runtime id is gone) is replaced.
 */
const GUARD_KEY = '__aiMcqAssistantContent';
const existing = (window as any)[GUARD_KEY] as { alive: () => boolean } | undefined;
const ownChrome = chrome;
if (!existing || !existing.alive()) {
  (window as any)[GUARD_KEY] = {
    alive: () => {
      try {
        return !!ownChrome.runtime?.id;
      } catch {
        return false;
      }
    },
  };
  initContentScript();
}

function initContentScript(): void {
  const extractor = new DOMQuestionExtractor();
  const interaction = new DOMInteractionManager();

  // Observer sends updates to the side panel
  const observer = new DOMQuestionObserver(extractor, (questions, currentQuestion) => {
    if (document.hidden) return; // Multi-tab isolation: never send messages from hidden background tabs
    try {
      chrome.runtime.sendMessage(
        {
          type: 'DOM_QUESTIONS_EXTRACTED',
          payload: { questions, currentQuestion, url: window.location.href, title: document.title },
        },
        () => void chrome.runtime.lastError,
      );
    } catch (err) {
      // Context may be invalidated if extension was reloaded
    }
  });
  observer.start();

  // -------------------------------------------------------------------------
  // Messaging helpers
  // -------------------------------------------------------------------------

  function sendToBackground<T = any>(type: string, payload: unknown): Promise<T & { success: boolean; error?: string }> {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res: any) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ success: false, error: lastError.message || 'Extension messaging error' } as any);
          } else {
            resolve(res || ({ success: false, error: 'No response from extension background' } as any));
          }
        });
      } catch (err: any) {
        resolve({ success: false, error: err?.message || 'Extension messaging error' } as any);
      }
    });
  }

  function backendPost(endpoint: string, body: unknown) {
    return sendToBackground<{ data?: any }>('BACKEND_FETCH', {
      endpoint,
      options: { method: 'POST', body: JSON.stringify(body) },
    });
  }

  function isPlaceholderQuestion(q: ExtractedQuestion): boolean {
    const t = q.questionText.trim();
    return t.includes(VISUAL_PLACEHOLDER_PROMPT) || /^question \d+$/i.test(t);
  }

  /**
   * Turns the question's images into bytes for Gemini. Unreadable images (cross-origin canvas,
   * failed downloads) and image-only questions fall back to a cropped screenshot of the
   * question, which Chrome only allows while the tab is the visible one in its window.
   */
  async function prepareQuestionMedia(q: ExtractedQuestion): Promise<ResolvedMedia> {
    const refs = q.images || [];
    const placeholder = isPlaceholderQuestion(q);
    if (refs.length === 0 && !placeholder) return { images: [], failures: [], screenshotUsed: false };

    const handle = extractor.getQuestionMedia(q.fingerprint);
    const { items, unreadable } = handle
      ? await buildMediaRequest(refs, handle.imageElements)
      : { items: [], unreadable: refs.length };

    const first = items.length
      ? await sendToBackground<ResolvedMedia>('RESOLVE_MEDIA', { items })
      : ({ success: true, images: [], failures: [], screenshotUsed: false } as any);
    const images = first.images || [];
    const failures: string[] = [...(first.failures || [])];
    if (unreadable > 0) failures.push(`${unreadable} figure(s) could not be read from the page`);

    const needScreenshot = failures.length > 0 || (placeholder && images.length === 0);
    if (needScreenshot && handle) {
      if (document.hidden) {
        failures.push('Screenshot skipped: tab is not visible');
      } else {
        handle.region.scrollIntoView({ block: 'center' });
        await sleep(400);
        const rect = regionScreenshotRect(handle.region);
        if (rect) {
          const shot = await sendToBackground<ResolvedMedia>('RESOLVE_MEDIA', { screenshotRect: rect });
          images.push(...(shot.images || []));
          failures.push(...(shot.failures || []));
          return { images, failures, screenshotUsed: !!shot.screenshotUsed };
        }
      }
    }
    return { images, failures, screenshotUsed: false };
  }

  // -------------------------------------------------------------------------
  // Messages from the side panel
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'DOM_EXTRACT_QUESTIONS': {
        const questions = extractor.extractAllQuestions();
        sendResponse({
          success: true,
          questions,
          currentQuestion: questions[0],
          url: window.location.href,
          title: document.title,
        });
        return false;
      }

      case 'PREPARE_QUESTION_MEDIA' as any: {
        const { fingerprint } = (message as any).payload || {};
        const questions = extractor.extractAllQuestions(); // refresh live element handles
        const q = questions.find((x) => x.fingerprint === fingerprint);
        if (!q) {
          sendResponse({ images: [], failures: ['Question is no longer on the page'], screenshotUsed: false });
          return false;
        }
        prepareQuestionMedia(q).then(sendResponse);
        return true;
      }

      case 'FILL_TEXT_ANSWER' as any: {
        const { inputSelector, answer } = (message as any).payload || {};
        sendResponse(interaction.fillTextAnswer(inputSelector, String(answer || '')));
        return false;
      }

      case 'CONFIRM_SELECTION': {
        const payload = message.payload as any;
        if (payload.optionId === 'TEXT') {
          // Typed-answer question: elementSelector is the answer box, optionText the answer
          sendResponse(interaction.fillTextAnswer(payload.elementSelector, String(payload.optionText || '')));
          return false;
        }
        if (Array.isArray(payload.optionIds) && payload.optionIds.length > 0) {
          sendResponse(interaction.selectMultipleOptions(payload.optionIds, payload.options || []));
        } else {
          sendResponse(interaction.selectOption(payload.optionId, payload.elementSelector, payload.optionText));
        }
        return false;
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
            sendResponse({ ...result, match: multiMatch, matched: true });
            return false;
          }
        }

        const match = matchAIAnswerToOptions(aiResult, options);
        if (match.isMatched && match.matchedOption) {
          const result = interaction.selectOption(match.matchedId!, match.matchedOption.elementSelector, match.matchedText!);
          sendResponse({ ...result, match, matched: true });
          return false;
        }

        // No match: report it. Never guess an option on the user's behalf.
        sendResponse({ success: false, matched: false, message: 'Could not match Gemini answer to DOM options.', match });
        return false;
      }

      case 'REORDER_OPTIONS' as any: {
        const { targetSequence, options } = (message as any).payload || {};
        interaction.reorderOptions(targetSequence || [], options || []).then(sendResponse);
        return true;
      }

      case 'SUBMIT_ANSWER' as any: {
        interaction.clickSubmitButton(6000).then(sendResponse);
        return true;
      }

      case 'INSPECT_SUBMISSION' as any: {
        const { options, selectedOptionId } = (message as any).payload || {};
        sendResponse(interaction.inspectSubmissionResult(options || [], selectedOptionId));
        return false;
      }

      case 'WAIT_AND_CLICK_NEXT' as any: {
        interaction.waitForAndClickNextButton(15000).then(sendResponse);
        return true;
      }

      case 'NAVIGATE_NEXT_QUESTION': {
        sendResponse(interaction.navigateNextQuestion());
        return false;
      }

      case 'START_TAB_AUTO_LOOP' as any: {
        startAutoLoop();
        sendResponse({ success: true, isRunning: true });
        return false;
      }

      case 'STOP_TAB_AUTO_LOOP' as any: {
        stopAutoLoop('Auto-Loop paused');
        sendResponse({ success: true, isRunning: false });
        return false;
      }

      case 'GET_TAB_AUTO_LOOP_STATUS' as any: {
        sendResponse({ isRunning: loopActive, status: loopStatus, solvedCount });
        return false;
      }

      default:
        return false;
    }
  });

  // -------------------------------------------------------------------------
  // Per-tab Auto-Loop. Every tab runs its own copy with its own state and session.
  // -------------------------------------------------------------------------

  let loopActive = false;
  let loopStatus = '';
  let solvedCount = 0;
  // Each start/stop bumps runId. A cycle from an older run sees the mismatch and exits,
  // so a quick stop + start can never leave two cycles answering in parallel.
  let runId = 0;
  let cycleRunningFor = -1;
  let sessionId: string | undefined;
  let failures = 0;
  let busyRetries = 0;
  let idleSince = 0;
  let lowConfidence = 0;
  const submitted = new Set<string>();
  // Answers already fetched in this run: re-checking a question never re-asks the backend
  const answers = new Map<string, any>();
  // How many times each question was picked up without being submitted (loop detector)
  const attempts = new Map<string, number>();

  const MAX_FAILURES = 4;
  // Rate limits are waited out, not treated as failures. 40 waits of up to 2 min each
  // covers a per-minute limit many times over; only a fully used daily quota stops the loop.
  const MAX_BUSY_RETRIES = 40;
  const MAX_ATTEMPTS_PER_QUESTION = 4;
  const MIN_AUTO_CONFIDENCE = 0.6;
  // Background tabs: Chrome slows the portal's own timers, so its next question can take much
  // longer to appear. Give it time before deciding the set is finished.
  const idleLimitMs = () => (document.hidden ? 180000 : 60000);

  // ---- Diagnostics: loop events go to the backend log (see "AutoLoop" lines there) ----
  const instanceId = Math.random().toString(36).slice(2, 6);
  let lastTracedStatus = '';
  function trace(event: string, data: Record<string, unknown> = {}): void {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'BACKEND_FETCH',
          payload: {
            endpoint: '/api/debug/loop-log',
            options: {
              method: 'POST',
              body: JSON.stringify({
                tab: instanceId,
                page: (document.title || '').slice(0, 40),
                path: location.pathname.slice(-24),
                hidden: document.hidden,
                solved: solvedCount,
                event,
                ...data,
              }),
            },
          },
        },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // never let logging break the loop
    }
  }

  // Errors that retrying cannot fix. The loop must stop and say why.
  const FATAL_ERROR =
    /not configured|pairing token|api key|api_key|permission denied|failed to fetch|not reachable|session is (paused|stopped)|extension context invalidated/i;
  // Gemini busy / rate limited / slow: wait longer and try again, do not give up quickly.
  const BUSY_ERROR = /429|quota|rate.?limit|resource.?exhausted|overloaded|unavailable|503|timed out|timeout|message port closed/i;

  function startAutoLoop(): void {
    runId++;
    loopActive = true;
    submitted.clear();
    answers.clear();
    attempts.clear();
    failures = 0;
    busyRetries = 0;
    idleSince = 0;
    lowConfidence = 0;
    loopStatus = 'Auto-Loop starting...';
    trace('start', { url: location.href.slice(0, 120) });
    void runCycle(runId);
  }

  function stopAutoLoop(status: string): void {
    runId++;
    loopActive = false;
    loopStatus = status;
    trace('stop', { status });
  }

  function scheduleCycle(run: number, delayMs: number): void {
    if (cycleRunningFor === run) cycleRunningFor = -1;
    if (loopStatus !== lastTracedStatus) {
      lastTracedStatus = loopStatus;
      trace('status', { status: loopStatus });
    }
    const t0 = Date.now();
    // sleep() keeps working in background tabs, unlike setTimeout
    sleep(delayMs).then(() => {
      const late = Date.now() - t0 - delayMs;
      if (late > 5000) trace('late-wakeup', { delayMs, lateMs: late });
      if (loopActive && run === runId) void runCycle(run);
    });
  }

  async function runCycle(run: number): Promise<void> {
    if (!loopActive || run !== runId || cycleRunningFor === run) return;
    cycleRunningFor = run;
    const alive = () => loopActive && run === runId;
    const finish = (status: string) => {
      if (run === runId) stopAutoLoop(status);
    };

    try {
      // Work top to bottom through every live question not answered in this run
      const questions = extractor.extractAllQuestions();
      const pending = questions.filter((q) => !submitted.has(q.fingerprint));
      if (pending.length === 0) {
        if (!idleSince) idleSince = Date.now();
        // Finish once nothing new shows up (end of the practice set). Before answering
        // anything, wait longer: the first question may still be loading.
        const limit = submitted.size > 0 ? idleLimitMs() : idleLimitMs() * 2;
        if (Date.now() - idleSince > limit) {
          finish(
            submitted.size > 0
              ? `✅ No new questions appeared for ${Math.round(limit / 1000)}s. Auto-Loop finished (${solvedCount} answered${lowConfidence ? `, ${lowConfidence} low-confidence` : ''}).`
              : '⏸️ No questions found on this page.',
          );
          return;
        }
        loopStatus = questions.length === 0 ? 'Scanning webpage for questions...' : 'Waiting for next question to render...';
        scheduleCycle(run, 1000);
        return;
      }
      idleSince = 0;

      const q = pending[0];
      const shortText = q.questionText.replace(/\s+/g, ' ').slice(0, 45);

      // Loop detector: the same question keeps coming back without being submitted
      const tries = (attempts.get(q.fingerprint) || 0) + 1;
      attempts.set(q.fingerprint, tries);
      if (tries > MAX_ATTEMPTS_PER_QUESTION) {
        trace('stuck-question', { fp: q.fingerprint, text: q.questionText.slice(0, 160), tries });
        finish(`⏸️ Stuck on "${shortText}..." (tried ${tries - 1} times without getting past it). Answer it manually, then restart.`);
        return;
      }

      // Images / figures / screenshot
      let images: ResolvedMedia['images'] = [];
      if ((q.images && q.images.length) || isPlaceholderQuestion(q)) {
        loopStatus = `1. Reading image(s) for: "${shortText}..."`;
        const media = await prepareQuestionMedia(q);
        if (!alive()) return;
        images = media.images;
        if (isPlaceholderQuestion(q) && images.length === 0) {
          finish(
            `⏸️ This question is an image and could not be read (${media.failures.join('; ') || 'no image found'}). Keep this tab visible in its window so a screenshot can be taken, then restart.`,
          );
          return;
        }
      }

      loopStatus = `1. Solving with Gemini${images.length ? ` (+${images.length} image)` : ''}: "${shortText}..."`;
      trace('solve', {
        fp: q.fingerprint,
        strategy: q.extractionStrategy,
        type: q.isOrderingQuestion ? 'ordering' : q.isMultipleChoiceMultipleAnswer ? 'multi' : 'single',
        text: q.questionText.replace(/\s+/g, ' ').slice(0, 200),
        options: q.options.map((o) => `${o.id}:${o.text.slice(0, 40)}`),
        images: images.length,
        pending: pending.length,
        cachedLocally: answers.has(q.fingerprint),
      });

      const cachedAnswer = answers.get(q.fingerprint);
      const response = cachedAnswer
        ? { success: true, data: { answer: cachedAnswer, sessionId } }
        : await backendPost('/api/questions/solve', {
        sessionId,
        pageUrl: window.location.href,
        pageTitle: document.title,
        question: q.questionText,
        options: q.options.map((o) => ({ id: o.id, text: o.text })),
        questionFingerprint: q.fingerprint,
        questionNumber: q.questionNumber,
        isMultipleChoiceMultipleAnswer: q.isMultipleChoiceMultipleAnswer,
        isOrderingQuestion: q.isOrderingQuestion,
        questionType: q.questionType,
        images: images.length ? images : undefined,
      });
      if (!alive()) return;

      const answer = response?.data?.answer;
      if (!response?.success || !answer) {
        const reason = response?.error || 'Backend returned no answer';
        if (FATAL_ERROR.test(reason)) {
          finish(`⏸️ Stopped: ${reason}`);
          return;
        }
        if (BUSY_ERROR.test(reason)) {
          busyRetries++;
          const askedSecs = Number((reason.match(/retry in (\d+(?:\.\d+)?)\s*s/i) || [])[1]);
          // Every model out of daily quota: waiting hours is pointless, stop and say so
          if (askedSecs > 1800 || busyRetries > MAX_BUSY_RETRIES) {
            const hours = askedSecs > 1800 ? ` Quota resets in about ${Math.ceil(askedSecs / 3600)}h (midnight US Pacific).` : '';
            finish(`⏸️ Every Gemini model is out of free quota.${hours} Enable billing in Google AI Studio for higher limits.`);
            return;
          }
          const wait = askedSecs > 0 ? Math.min(120000, askedSecs * 1000 + 1000) : Math.min(60000, 4000 * 2 ** (busyRetries - 1));
          loopStatus = `⏳ Gemini rate limit: waiting ${Math.round(wait / 1000)}s, then continuing automatically...`;
          scheduleCycle(run, wait);
          return;
        }
        failures++;
        if (failures >= MAX_FAILURES) {
          finish(`⏸️ Stopped after ${failures} failed attempts: ${reason}`);
          return;
        }
        loopStatus = `Solve failed (${failures}/${MAX_FAILURES}): ${reason}. Retrying...`;
        scheduleCycle(run, 2500);
        return;
      }

      failures = 0;
      busyRetries = 0;
      if (response.data.sessionId) sessionId = response.data.sessionId;
      answers.set(q.fingerprint, answer);
      trace('answer', {
        fp: q.fingerprint,
        id: answer.selected_option_id,
        text: String(answer.answer_text || '').slice(0, 60),
        confidence: answer.confidence,
        needsReview: answer.needs_review,
        cached: response.data.cached,
      });

      // Drag & Drop / sequence questions: drag the items into the AI's order, verify, then submit
      if (q.isOrderingQuestion || (answer.ordered_sequence && answer.ordered_sequence.length > 0)) {
        const seq: string[] = answer.ordered_sequence || (answer.selected_option_id || '').split(/[,;\->\s]+/).filter(Boolean);
        const validIds = new Set(q.options.map((o) => o.id));
        if (seq.length !== q.options.length || seq.some((id) => !validIds.has(id)) || new Set(seq).size !== seq.length) {
          finish(`⏸️ Sequence answer looks incomplete [${seq.join(' → ')}]. Arrange it manually.`);
          return;
        }
        if (document.hidden) {
          // Drag libraries animate with requestAnimationFrame, which background tabs pause
          attempts.set(q.fingerprint, tries - 1); // waiting is not a failed attempt
          loopStatus = `⏳ Sequence question waiting: switch to this tab so it can drag [${seq.join(' → ')}]`;
          scheduleCycle(run, 2000);
          return;
        }
        loopStatus = `2. Dragging into order [${seq.join(' → ')}]...`;
        const reorder = await interaction.reorderOptions(seq, q.options);
        if (!alive()) return;
        if (!reorder.success) {
          finish(`⏸️ ${reorder.message}. Arrange it manually as [${seq.join(' → ')}].`);
          return;
        }
        submitted.add(q.fingerprint);
        solvedCount++;
        loopStatus = `2. Arranged [${seq.join(' → ')}]. Submitting...`;
        await sleep(500);
        if (!alive()) return;
        const near = extractor.getQuestionMedia(q.fingerprint)?.region;
        const submitResult = await interaction.clickSubmitButton(6000, near);
        await sleep(700);
        if (!alive()) return;
        const nextResult = await interaction.waitForAndClickNextButton(10000, near);
        if (!alive()) return;
        if (!submitResult.success && !nextResult.success) {
          finish(`✅ Arranged the sequence. No Submit or Next button found, so nothing was submitted.`);
          return;
        }
        scheduleCycle(run, 1200);
        return;
      }

      // Unsure answers are still answered (pausing here stopped the loop every few questions);
      // they are counted and reported when the loop finishes.
      const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
      if (answer.needs_review || confidence < MIN_AUTO_CONFIDENCE) lowConfidence++;

      // Typed answer: type it into the box, then submit and move on like any other question
      if (q.questionType === 'DESCRIPTIVE' && q.options.length === 0) {
        const typed = String(answer.answer_text || '').trim();
        const fill = interaction.fillTextAnswer(q.inputSelector, typed);
        if (!fill.success) {
          finish(`⏸️ ${fill.message} Type "${typed.slice(0, 60)}" manually, then restart.`);
          return;
        }
        submitted.add(q.fingerprint);
        solvedCount++;
        loopStatus = `2. Typed "${typed.slice(0, 40)}". Submitting...`;
        await sleep(500);
        if (!alive()) return;
        const nearBox = extractor.getQuestionMedia(q.fingerprint)?.region;
        const submitTyped = await interaction.clickSubmitButton(6000, nearBox);
        await sleep(700);
        if (!alive()) return;
        loopStatus = '3. Clicking Next question...';
        const nextTyped = await interaction.waitForAndClickNextButton(10000, nearBox);
        if (!alive()) return;
        if (!submitTyped.success && !nextTyped.success) {
          finish(`✅ Typed the answer. No Submit or Next button found, so nothing was submitted.`);
          return;
        }
        scheduleCycle(run, 1200);
        return;
      }

      // Match and select
      let matchedIdStr = '';
      let selection: { success: boolean; message: string } | null = null;
      if (q.isMultipleChoiceMultipleAnswer) {
        const multi = matchAIMultipleAnswersToOptions(answer, q.options);
        if (multi.isMatched && multi.matchedIds.length > 0) {
          selection = interaction.selectMultipleOptions(multi.matchedIds, q.options);
          matchedIdStr = multi.matchedIds.join(', ');
        }
      } else {
        const match = matchAIAnswerToOptions(answer, q.options);
        if (match.isMatched && match.matchedOption) {
          selection = interaction.selectOption(match.matchedId!, match.matchedOption.elementSelector, match.matchedText!);
          matchedIdStr = match.matchedId!;
        }
      }

      if (!matchedIdStr) {
        finish(`⏸️ Could not match the AI answer "${String(answer.answer_text).slice(0, 60)}" to an option on the page. Answer this one manually.`);
        return;
      }
      if (selection && !selection.success) {
        finish(`⏸️ Could not click option [${matchedIdStr}] on the page: ${selection.message}`);
        return;
      }

      submitted.add(q.fingerprint);
      solvedCount++;

      // More unanswered questions on this page: mark them all before submitting anything
      const remaining = pending.length - 1;
      if (remaining > 0) {
        loopStatus = `2. Marked [${matchedIdStr}]. ${remaining} more on this page...`;
        scheduleCycle(run, 350);
        return;
      }

      loopStatus = `2. Marked option(s) [${matchedIdStr}]. Submitting...`;
      await sleep(650);
      if (!alive()) return;

      const near = extractor.getQuestionMedia(q.fingerprint)?.region;
      const submitResult = await interaction.clickSubmitButton(6000, near);
      await sleep(700);
      if (!alive()) return;

      loopStatus = '3. Clicking Next question...';
      const nextResult = await interaction.waitForAndClickNextButton(10000, near);
      if (!alive()) return;

      if (!submitResult.success && !nextResult.success) {
        finish(`✅ Marked ${solvedCount} answer(s). No Submit or Next button found, so nothing was submitted.`);
        return;
      }

      scheduleCycle(run, 1200);
    } catch (err: any) {
      if (!alive()) return;
      failures++;
      if (failures >= MAX_FAILURES) {
        finish(`⏸️ Stopped after repeated errors: ${err?.message || err}`);
        return;
      }
      loopStatus = `Loop error: ${err?.message || err}. Retrying in 2s...`;
      scheduleCycle(run, 2000);
    }
  }

  // Rescan on URL changes in single page apps (SPA)
  window.addEventListener('popstate', () => observer.scan(true));
  window.addEventListener('hashchange', () => observer.scan(true));
}
