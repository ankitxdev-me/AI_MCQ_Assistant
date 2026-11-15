/*
 * Browser E2E harness: runs the real built content script (apps/extension/dist/content.js) in a
 * normal page by standing in for the chrome.* APIs the extension background would provide.
 *
 * - BACKEND_FETCH goes to the real local backend (real Gemini), unless window.__mock is set.
 * - RESOLVE_MEDIA uses the real background image code (bundled to e2e/.build/bgmedia.js).
 * - SLEEP is a plain timer (the real extension runs it in the service worker).
 *
 * Usage in a page:  await import('/e2e/harness.js')  ->  window.__e2e.load()  ->  __e2e.start()
 */
(function () {
  const TOKEN = 'ai_mcq_assistant_secret_token_change_in_production';
  const listeners = [];
  window.__e2eLog = [];

  async function handle(msg) {
    switch (msg.type) {
      case 'SLEEP':
        await new Promise((r) => setTimeout(r, msg.payload.ms));
        return { success: true };
      case 'DOM_QUESTIONS_EXTRACTED':
        return undefined;
      case 'RESOLVE_MEDIA': {
        const res = await window.BgMedia.resolveMediaItems(msg.payload.items || []);
        if (msg.payload.screenshotRect) res.failures.push('Screenshot: not available in harness');
        return { success: true, ...res, screenshotUsed: false };
      }
      case 'BACKEND_FETCH': {
        const body = JSON.parse(msg.payload.options.body || '{}');
        const entry = {
          question: body.question,
          options: body.options,
          images: (body.images || []).map((i) => ({ mimeType: i.mimeType, bytes: i.data.length, label: i.label })),
        };
        window.__e2eLog.push(entry);
        if (window.__mock) {
          const answer = window.__mock(body);
          entry.answer = answer;
          return { success: true, data: { sessionId: 'mock', answer } };
        }
        const r = await fetch('http://127.0.0.1:3000' + msg.payload.endpoint, {
          method: msg.payload.options.method || 'POST',
          headers: { 'Content-Type': 'application/json', 'x-pairing-token': TOKEN },
          body: msg.payload.options.body,
        });
        const j = await r.json();
        entry.answer = j.answer;
        entry.cached = j.cached;
        return r.ok ? { success: true, data: j } : { success: false, error: j.message };
      }
      default:
        return undefined;
    }
  }

  window.chrome = {
    runtime: {
      id: 'e2e',
      lastError: undefined,
      sendMessage(msg, cb) {
        handle(msg).then((r) => cb && cb(r));
      },
      onMessage: {
        addListener: (f) => listeners.push(f),
        removeListener: () => {},
      },
    },
  };

  function send(msg) {
    return new Promise((resolve) => {
      for (const f of listeners) f(msg, {}, resolve);
    });
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  window.__e2e = {
    send,
    async load() {
      await loadScript('/e2e/.build/bgmedia.js');
      await loadScript('/apps/extension/dist/content.js?' + Date.now());
    },
    start: () => send({ type: 'START_TAB_AUTO_LOOP' }),
    stop: () => send({ type: 'STOP_TAB_AUTO_LOOP' }),
    status: () => send({ type: 'GET_TAB_AUTO_LOOP_STATUS' }),
    extract: () => send({ type: 'DOM_EXTRACT_QUESTIONS' }),
  };
})();
