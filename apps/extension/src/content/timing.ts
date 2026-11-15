/**
 * Sleep that keeps working in background tabs.
 *
 * Chrome throttles setTimeout in hidden tabs (to 1s, and after ~5 minutes to once a minute).
 * That stalled every wait in the Auto-Loop as soon as the user switched to another tab.
 * The extension service worker is not throttled, so we let it run the timer and wake us
 * with a message reply. Message delivery to hidden tabs is not throttled.
 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (!document.hidden) return new Promise((r) => setTimeout(r, ms));

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      chrome.runtime.sendMessage({ type: 'SLEEP', payload: { ms } }, () => {
        void chrome.runtime.lastError; // read it so Chrome does not log it
        finish();
      });
    } catch {
      setTimeout(finish, ms);
      return;
    }
    // Safety net if the worker never answers
    setTimeout(finish, ms + 15000);
  });
}
