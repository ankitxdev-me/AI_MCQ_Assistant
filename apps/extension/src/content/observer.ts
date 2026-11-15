import { DOMQuestionExtractor } from './extractor';
import { ExtractedQuestion } from '@ai-mcq/shared-types';

export type OnQuestionsChangedCallback = (
  questions: ExtractedQuestion[],
  activeQuestion?: ExtractedQuestion,
) => void;

export class DOMQuestionObserver {
  private observer: MutationObserver | null = null;
  private debounceTimer: number | null = null;
  private extractor: DOMQuestionExtractor;
  private callback: OnQuestionsChangedCallback;
  private lastFingerprints: string = '';

  constructor(extractor: DOMQuestionExtractor, callback: OnQuestionsChangedCallback) {
    this.extractor = extractor;
    this.callback = callback;
  }

  public start(): void {
    if (this.observer) return;

    // Run initial scan only if page is visible
    if (!document.hidden) {
      this.scan();
    }

    this.observer = new MutationObserver(() => {
      this.handleMutation();
    });

    this.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['checked', 'aria-checked', 'class', 'style'],
    });

    // Multi-tab isolation: listen for visibility changes
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // Tab just became active: rescan immediately
        this.scan(true);
      }
    });
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  public scan(force: boolean = false): void {
    // Multi-tab isolation: never extract or notify from background tabs
    if (document.hidden) return;

    const questions = this.extractor.extractAllQuestions();
    const fingerprintsKey = questions.map((q) => q.fingerprint).join('|');

    if (force || fingerprintsKey !== this.lastFingerprints) {
      this.lastFingerprints = fingerprintsKey;
      const activeQuestion = questions.length > 0 ? questions[0] : undefined;
      this.callback(questions, activeQuestion);
    }
  }

  private handleMutation(): void {
    // Multi-tab isolation: ignore mutations happening in background tabs
    if (document.hidden) return;

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.scan();
    }, 350); // 350ms debounce
  }
}

