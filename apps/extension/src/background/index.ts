const BACKEND_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_PAIRING_TOKEN = 'ai_mcq_assistant_secret_token_change_in_production';

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

  const response = await fetch(`${BACKEND_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(errorData.message || `Request failed with status ${response.status}`);
  }

  return response.json();
}

// Handle runtime messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BACKEND_FETCH') {
    const { endpoint, options } = message.payload;
    fetchBackend(endpoint, options)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async reply
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

