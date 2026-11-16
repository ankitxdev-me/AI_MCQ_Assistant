import { resolveMediaItems, cropScreenshot, MediaItem, CropRect, ImagePayload } from './media';

const BACKEND_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_PAIRING_TOKEN = 'ai_mcq_assistant_secret_token_change_in_production';
// Gemini with images can take a while; anything longer means the backend is stuck.
const BACKEND_TIMEOUT_MS = 120000;

// Ensure action icon click opens sidepanel directly in the browser window
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.log('Sidepanel behavior config error:', err));
}

// Fallback listener for action click to guarantee sidepanel opens
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab?.windowId && (chrome.sidePanel as any)?.open) {
      try {
        await (chrome.sidePanel as any).open({ windowId: tab.windowId });
      } catch (err) {
        console.warn('Failed to open side panel via action click:', err);
      }
    }
  });
}

/**
 * Keeps the service worker alive while long work is in flight.
 * Chrome stops an idle worker after ~30s, which killed slow Gemini requests mid-way and
 * left the Auto-Loop with "message port closed". Any extension API call resets the idle timer.
 */
let keepAliveCount = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
async function withKeepAlive<T>(work: () => Promise<T>): Promise<T> {
  keepAliveCount++;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
  }
  try {
    return await work();
  } finally {
    keepAliveCount--;
    if (keepAliveCount === 0 && keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }
}

// Retrieve pairing token from chrome.storage or use default
async function getPairingToken(): Promise<string> {
  const result = await chrome.storage.local.get(['pairingToken']);
  return result.pairingToken || DEFAULT_PAIRING_TOKEN;
}

// Background API helper with localhost authentication
async function fetchBackend(endpoint: string, options: RequestInit = {}): Promise<any> {
  const token = await getPairingToken();
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('x-pairing-token', token);

  let response: Response;
  try {
    response = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') throw new Error('Backend request timed out');
    throw new Error(
      `Failed to fetch: backend is not running at ${BACKEND_BASE_URL}. Double-click start-backend.cmd in the AI_MCQ_Assistant folder.`,
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.message || `Request failed with status ${response.status}`);
  }

  return response.json();
}

// captureVisibleTab is limited to 2 calls per second; queue captures across tabs.
let captureChain: Promise<unknown> = Promise.resolve();
function captureTab(windowId: number): Promise<string> {
  const run = captureChain.then(async () => {
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    await new Promise((r) => setTimeout(r, 600));
    return shot;
  });
  captureChain = run.catch(() => {});
  return run;
}

async function resolveMedia(
  payload: { items?: MediaItem[]; screenshotRect?: CropRect; tabId?: number },
  senderTab?: chrome.tabs.Tab,
): Promise<{ images: ImagePayload[]; failures: string[]; screenshotUsed: boolean }> {
  const { images, failures } = await resolveMediaItems(payload.items || []);
  let screenshotUsed = false;

  if (payload.screenshotRect) {
    try {
      const tab = payload.tabId ? await chrome.tabs.get(payload.tabId) : senderTab;
      if (!tab?.id || tab.windowId === undefined) throw new Error('Unknown tab');
      // Chrome can only screenshot the tab that is currently shown in its window
      if (!tab.active) throw new Error('Tab is not the visible tab in its window');
      const shot = await captureTab(tab.windowId);
      images.push(await cropScreenshot(shot, payload.screenshotRect));
      screenshotUsed = true;
    } catch (err: any) {
      failures.push(`Screenshot: ${err?.message || err}`);
    }
  }

  return { images, failures, screenshotUsed };
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BACKEND_FETCH') {
    const { endpoint, options } = message.payload;
    withKeepAlive(() => fetchBackend(endpoint, options))
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async reply
  }

  // Timer for content scripts in throttled background tabs (see content/timing.ts)
  if (message.type === 'SLEEP') {
    const ms = Math.min(Math.max(Number(message.payload?.ms) || 0, 0), 60000);
    setTimeout(() => sendResponse({ success: true }), ms);
    return true;
  }

  if (message.type === 'RESOLVE_MEDIA') {
    withKeepAlive(() => resolveMedia(message.payload || {}, sender.tab))
      .then((res) => sendResponse({ success: true, ...res }))
      .catch((err) => sendResponse({ success: false, images: [], failures: [String(err?.message || err)] }));
    return true;
  }

  if (message.type === 'CHECK_HEALTH') {
    fetch(`${BACKEND_BASE_URL}/api/health`)
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      sendResponse({ tab });
    });
    return true;
  }

  if (message.type === 'OPEN_SIDEPANEL') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.windowId && (chrome.sidePanel as any)?.open) {
        (chrome.sidePanel as any).open({ windowId: tab.windowId })
          .then(() => sendResponse({ success: true }))
          .catch((err: any) => sendResponse({ success: false, error: err.message }));
      } else {
        sendResponse({ success: false, error: 'Side panel API not available' });
      }
    });
    return true;
  }

  if (message.type === 'OPEN_STANDALONE_WINDOW') {
    const isCompact = !!message.payload?.isCompact;
    chrome.windows
      .create({
        url: chrome.runtime.getURL(`standalone.html${isCompact ? '?compact=true' : ''}`),
        type: 'popup',
        width: isCompact ? 340 : 440,
        height: isCompact ? 500 : 620,
        focused: true,
      })
      .then((win) => {
        sendResponse({ success: true, windowId: win.id });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'RESIZE_CURRENT_WINDOW') {
    const { width, height } = message.payload;
    chrome.windows.getCurrent((win) => {
      if (win?.id) {
        chrome.windows.update(win.id, { width, height });
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false });
      }
    });
    return true;
  }
});

// Handle keyboard shortcuts
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-standalone-window') {
      try {
        await chrome.windows.create({
          url: chrome.runtime.getURL('standalone.html'),
          type: 'popup',
          width: 440,
          height: 640,
          focused: true,
        });
      } catch (err) {
        console.error('Failed to open standalone window:', err);
      }
    }
  });
}
