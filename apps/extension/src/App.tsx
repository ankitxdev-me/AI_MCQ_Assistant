import React, { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Header } from './shared/components/Header';
import { SetupScreen } from './shared/components/SetupScreen';
import { MainScreen } from './shared/components/MainScreen';
import { SessionResults } from './shared/components/SessionResults';
import { ApiClient } from './shared/api';
import {
  ConfigStatusResponse,
  PracticeSession,
  ExtractedQuestion,
  WS_EVENTS,
} from '@ai-mcq/shared-types';

export const App: React.FC = () => {
  const isStandalone =
    typeof window !== 'undefined' &&
    (window.location.pathname.includes('standalone') ||
      window.location.search.includes('standalone=true') ||
      window.location.search.includes('window'));
  const [isCompact, setIsCompact] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('ai_mcq_compact') === 'true' || window.location.search.includes('compact=true');
    }
    return false;
  });
  const [backendOnline, setBackendOnline] = useState(false);
  const [configStatus, setConfigStatus] = useState<ConfigStatusResponse | null>(null);
  const [currentScreen, setCurrentScreen] = useState<'setup' | 'main' | 'results'>('main');
  const [activeTabInfo, setActiveTabInfo] = useState<{ url?: string; title?: string; id?: number } | null>(null);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [detectedQuestions, setDetectedQuestions] = useState<ExtractedQuestion[]>([]);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [isSolving, setIsSolving] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoPilot, setAutoPilot] = useState(false);
  const [autoPilotStatus, setAutoPilotStatus] = useState('');

  const autoPilotRef = useRef(false);
  const isLoopRunningRef = useRef(false);
  const submittedFingerprintsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    autoPilotRef.current = autoPilot;
    if (!autoPilot) {
      setAutoPilotStatus('');
    }
  }, [autoPilot]);

  // Synchronize activeQuestionIndex when live detected question changes
  useEffect(() => {
    if (detectedQuestions.length > 0 && session?.questions && session.questions.length > 0) {
      const liveFp = detectedQuestions[0].fingerprint;
      const idx = session.questions.findIndex((q) => q.fingerprint === liveFp);
      if (idx >= 0 && idx !== activeQuestionIndex) {
        setActiveQuestionIndex(idx);
      }
    }
  }, [detectedQuestions, session?.questions]);

  // Window this panel belongs to (side panel). Used so tab switches in OTHER windows are ignored.
  const ownWindowIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isStandalone && typeof chrome !== 'undefined' && chrome.windows?.getCurrent) {
      chrome.windows.getCurrent().then((w) => {
        ownWindowIdRef.current = w?.id ?? null;
      });
    }
  }, [isStandalone]);

  const isWebTab = (t?: chrome.tabs.Tab | null) =>
    !!t?.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://');

  /**
   * The tab this panel controls.
   * Side panel: the active tab of the window the panel lives in.
   * Pop-out window: the active tab of the last focused normal browser window.
   * (Before, "any active tab in any window" was used, so with two windows open the panel
   * could start, stop or read the Auto-Loop of a tab in the other window.)
   */
  const getTargetTab = useCallback(async (): Promise<chrome.tabs.Tab | null> => {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
    try {
      let windowId: number | undefined;
      if (!isStandalone) {
        const own = ownWindowIdRef.current ?? (await chrome.windows.getCurrent())?.id;
        windowId = own ?? undefined;
      } else {
        windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }))?.id;
      }
      if (windowId !== undefined) {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (isWebTab(tab)) return tab;
      }
    } catch (e) {
      console.warn('Could not query target tab:', e);
    }
    return null;
  }, [isStandalone]);

  // Helper to safely send message to the active Chrome tab
  const sendTabMessage = useCallback(
    async (msg: any): Promise<any> => {
      const tab = await getTargetTab();
      if (!tab?.id) {
        return { success: false, message: 'No target tab found' };
      }
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id!, msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, message: chrome.runtime.lastError.message });
          } else {
            resolve(res);
          }
        });
      });
    },
    [getTargetTab],
  );

  // 1. Initial health & config checks
  const checkHealthAndConfig = useCallback(async () => {
    try {
      await ApiClient.getHealth();
      setBackendOnline(true);

      const cfg = await ApiClient.getConfigStatus();
      setConfigStatus(cfg);

      if (!cfg.configured) {
        setCurrentScreen('setup');
      }
    } catch (e) {
      setBackendOnline(false);
    }
  }, []);

  // 2. Query active browser tab
  const refreshActiveTab = useCallback(async () => {
    const tab = await getTargetTab();
    if (tab) {
      setActiveTabInfo({ url: tab.url, title: tab.title, id: tab.id });
    }
  }, [getTargetTab]);

  // 3. Trigger DOM extraction from content script with automatic scripting injection fallback
  const triggerExtraction = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const tab = await getTargetTab();
      if (tab?.id) {
        setActiveTabInfo({ url: tab.url, title: tab.title, id: tab.id });
        chrome.tabs.sendMessage(
          tab.id,
          { type: 'DOM_EXTRACT_QUESTIONS' },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              // If content script was not injected yet, inject it dynamically
              if (chrome.scripting && chrome.scripting.executeScript) {
                chrome.scripting.executeScript(
                  {
                    target: { tabId: tab.id! },
                    files: ['content.js'],
                  },
                  () => {
                    setTimeout(() => {
                      chrome.tabs.sendMessage(
                        tab.id!,
                        { type: 'DOM_EXTRACT_QUESTIONS' },
                        (res) => {
                          if (res && res.questions) {
                            setDetectedQuestions(res.questions);
                          }
                        },
                      );
                    }, 100);
                  },
                );
              }
            } else if (response.questions) {
              setDetectedQuestions(response.questions);
            }
          },
        );
      }
    } catch (e) {
      console.warn('Could not contact content script directly:', e);
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  }, [getTargetTab]);

  const handleToggleCompact = () => {
    setIsCompact((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ai_mcq_compact', String(next));
        if (next) {
          document.documentElement.classList.add('compact-size');
        } else {
          document.documentElement.classList.remove('compact-size');
        }
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            type: 'RESIZE_CURRENT_WINDOW',
            payload: { width: next ? 340 : 430, height: next ? 500 : 630 },
          });
        }
      } catch (e) {}
      return next;
    });
  };

  const handlePopOut = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'OPEN_STANDALONE_WINDOW',
          payload: { isCompact },
        },
        () => {
          window.close();
        },
      );
    }
  };

  useEffect(() => {
    checkHealthAndConfig();
    refreshActiveTab();
    triggerExtraction();

    const interval = setInterval(checkHealthAndConfig, 5000);
    return () => clearInterval(interval);
  }, [checkHealthAndConfig, refreshActiveTab, triggerExtraction]);

  // Connect to backend WebSockets for real-time updates
  useEffect(() => {
    let socket: Socket | null = null;
    try {
      socket = io('http://127.0.0.1:3000', {
        transports: ['websocket', 'polling'],
      });

      socket.on(WS_EVENTS.SESSION_UPDATED, (updatedSession: PracticeSession) => {
        if (session && updatedSession.id === session.id) {
          setSession(updatedSession);
        }
      });
    } catch (e) {
      console.warn('Socket connection error', e);
    }

    return () => {
      if (socket) socket.disconnect();
    };
  }, [session]);

  // Listen for DOM_QUESTIONS_EXTRACTED from content script with strict tab filtering
  useEffect(() => {
    const handleMessage = (message: any, sender: any) => {
      if (message.type === 'DOM_QUESTIONS_EXTRACTED') {
        const { questions, url, title } = message.payload;
        // Multi-tab isolation: ignore extractions sent from other tabs / other windows
        if (sender?.tab?.id && activeTabInfo?.id && sender.tab.id !== activeTabInfo.id) {
          return;
        }
        if (!isStandalone && ownWindowIdRef.current !== null && sender?.tab?.windowId !== undefined && sender.tab.windowId !== ownWindowIdRef.current) {
          return;
        }

        setDetectedQuestions(questions);
        if (url) {
          setActiveTabInfo((prev) => ({ ...prev, url, title, id: sender?.tab?.id || prev?.id }));
        }

        // If session is active, automatically sync questions to backend session
        if (session && session.status === 'ACTIVE' && questions.length > 0) {
          ApiClient.extractQuestions(session.id, questions)
            .then((res) => {
              if (res.session) setSession(res.session);
            })
            .catch((err) => console.error('Error syncing questions:', err));
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
      return () => chrome.runtime.onMessage.removeListener(handleMessage);
    }
  }, [session, activeTabInfo?.id]);

  // Listen for browser tab changes with complete tab isolation
  useEffect(() => {
    const onTabActivated = async (activeInfo: chrome.tabs.TabActiveInfo) => {
      // A side panel only follows tabs in its own window
      if (!isStandalone && ownWindowIdRef.current !== null && activeInfo.windowId !== ownWindowIdRef.current) return;
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (tab && tab.id && tab.url && !tab.url.startsWith('chrome-extension://') && !tab.url.startsWith('chrome://')) {
          // Immediately wipe detected questions and submitted cache from previous tab
          setDetectedQuestions([]);
          submittedFingerprintsRef.current.clear();
          setActiveTabInfo({ url: tab.url, title: tab.title, id: tab.id });

          // Trigger fresh extraction on the newly focused tab
          chrome.tabs.sendMessage(tab.id, { type: 'DOM_EXTRACT_QUESTIONS' }, (res) => {
            if (res && res.questions) {
              setDetectedQuestions(res.questions);
            }
          });
        }
      } catch (e) {
        refreshActiveTab();
        triggerExtraction();
      }
    };

    const onTabUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (tabId === activeTabInfo?.id && changeInfo.status === 'complete') {
        triggerExtraction();
      }
    };

    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(onTabActivated);
      chrome.tabs.onUpdated?.addListener(onTabUpdated);
      return () => {
        chrome.tabs.onActivated.removeListener(onTabActivated);
        chrome.tabs.onUpdated?.removeListener(onTabUpdated);
      };
    }
  }, [activeTabInfo?.id, refreshActiveTab, triggerExtraction]);

  // Session Handlers
  const handleStartSession = async () => {
    if (!activeTabInfo?.url) return;
    try {
      const newSession = await ApiClient.createSession(
        activeTabInfo.url,
        activeTabInfo.title,
        activeTabInfo.id,
      );
      setSession(newSession);

      // Record any currently detected questions
      if (detectedQuestions.length > 0) {
        const synced = await ApiClient.extractQuestions(newSession.id, detectedQuestions);
        if (synced.session) setSession(synced.session);
      }
      setActiveQuestionIndex(0);
    } catch (err: any) {
      alert(`Failed to start session: ${err.message}`);
    }
  };

  const handlePauseSession = async () => {
    if (!session) return;
    const updated = await ApiClient.pauseSession(session.id);
    setSession(updated);
  };

  const handleResumeSession = async () => {
    if (!session) return;
    const updated = await ApiClient.resumeSession(session.id);
    setSession(updated);
  };

  const handleStopSession = async () => {
    if (!session) return;
    const updated = await ApiClient.stopSession(session.id);
    setSession(updated);
    setCurrentScreen('results');
  };

  // Solve with Gemini
  const handleSolveQuestion = async (q: ExtractedQuestion) => {
    setIsSolving(true);
    try {
      let currentSessionId = session?.id;

      // Auto-create session if not started yet
      if (!currentSessionId) {
        const newSession = await ApiClient.createSession(
          activeTabInfo?.url || 'http://localhost/practice',
          activeTabInfo?.title || 'Practice Quiz',
          activeTabInfo?.id,
        );
        setSession(newSession);
        currentSessionId = newSession.id;
        await ApiClient.extractQuestions(currentSessionId, [q]);
      }

      // Images / figures / screenshot of the question, read by the content script
      const media: any = q.images?.length || /^question \d+$/i.test(q.questionText.trim()) || q.questionText.includes('attached image')
        ? await sendTabMessage({ type: 'PREPARE_QUESTION_MEDIA', payload: { fingerprint: q.fingerprint } })
        : null;
      const images = Array.isArray(media?.images) && media.images.length ? media.images : undefined;

      const res = await ApiClient.solveQuestion({
        images,
        sessionId: currentSessionId,
        question: q.questionText,
        options: q.options.map((o) => ({ id: o.id, text: o.text })),
        questionFingerprint: q.fingerprint,
        questionNumber: q.questionNumber,
        isMultipleChoiceMultipleAnswer: q.isMultipleChoiceMultipleAnswer,
        isOrderingQuestion: q.isOrderingQuestion,
        questionType: q.questionType,
      });

      // Update question locally
      if (res.success && res.answer) {
        setDetectedQuestions((prev) =>
          prev.map((item) =>
            item.fingerprint === q.fingerprint ? { ...item, aiAnswer: res.answer } : item,
          ),
        );
      }
    } catch (err: any) {
      alert(`AI Solve Error: ${err.message}`);
    } finally {
      setIsSolving(false);
    }
  };

  // Confirm selection on page
  const handleConfirmSelection = async (optionId: string, elementSelector?: string, optionText?: string) => {
    await sendTabMessage({
      type: 'CONFIRM_SELECTION',
      payload: { optionId, elementSelector, optionText },
    });

    // Update backend session if active
    const curQ = detectedQuestions[activeQuestionIndex] || (session?.questions || [])[activeQuestionIndex];
    if (session && curQ) {
      const updated = await ApiClient.confirmSelection(session.id, curQ.fingerprint, optionId);
      setSession(updated);
    }
  };

  // Reorder options on page
  const handleReorder = async (targetSequence: string[]) => {
    const curQ = detectedQuestions[activeQuestionIndex] || detectedQuestions[0];
    await sendTabMessage({
      type: 'REORDER_OPTIONS',
      payload: { targetSequence, options: curQ?.options || [] },
    });
  };

  // Reset/Clear accumulated session questions
  const handleResetSession = async () => {
    if (session) {
      try {
        await ApiClient.stopSession(session.id);
      } catch (e) {}
    }
    setSession(null);
    setDetectedQuestions([]);
    setActiveQuestionIndex(0);
    triggerExtraction();
  };

  // Submit answer on page and await the response
  const handleSubmitAnswer = async () => {
    return await sendTabMessage({ type: 'SUBMIT_ANSWER' });
  };

  // Navigate to Next Question on webpage
  const handleNextQuestion = async () => {
    const res = await sendTabMessage({ type: 'NAVIGATE_NEXT_QUESTION' });
    triggerExtraction();

    // Advance carousel index if multiple detected on same page
    const total = (session?.questions || detectedQuestions).length;
    if (activeQuestionIndex < total - 1) {
      setActiveQuestionIndex((prev) => prev + 1);
    }
    return res;
  };

  // Continuously sync Auto-Pilot status with the currently viewed tab (supports concurrent multi-tab automation)
  useEffect(() => {
    let isSubscribed = true;
    const syncTabStatus = async () => {
      try {
        const res: any = await sendTabMessage({ type: 'GET_TAB_AUTO_LOOP_STATUS' });
        if (isSubscribed && res && typeof res.isRunning === 'boolean') {
          setAutoPilot(res.isRunning);
          if (res.status) {
            setAutoPilotStatus(res.status);
          }
        }
      } catch (e) {}
    };

    syncTabStatus();
    const interval = setInterval(syncTabStatus, 1000);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [sendTabMessage, activeTabInfo?.id]);

  const handleToggleAutoPilot = async () => {
    if (autoPilot) {
      await sendTabMessage({ type: 'STOP_TAB_AUTO_LOOP' });
      setAutoPilot(false);
      setAutoPilotStatus('Auto-Loop stopped on this tab');
    } else {
      const res: any = await sendTabMessage({ type: 'START_TAB_AUTO_LOOP' });
      if (res && res.isRunning) {
        setAutoPilot(true);
        setAutoPilotStatus('Auto-Loop active & running in background on this tab...');
      }
    }
  };

  return (
    <div
      className={`flex flex-col h-full w-full bg-slate-50 text-slate-800 font-sans antialiased select-none ${
        isCompact ? 'compact-mode' : ''
      }`}
    >
      <Header
        backendOnline={backendOnline}
        geminiConfigured={!!configStatus?.configured}
        onOpenSettings={() => setCurrentScreen('setup')}
        onRefresh={triggerExtraction}
        isRefreshing={isRefreshing}
        isCompact={isCompact}
        onToggleCompact={handleToggleCompact}
        onPopOut={handlePopOut}
        isStandalone={isStandalone}
      />

      <main className="flex-1 flex flex-col overflow-y-auto">
        {currentScreen === 'setup' ? (
          <SetupScreen
            configStatus={configStatus}
            onConfigSaved={() => {
              checkHealthAndConfig();
              setCurrentScreen('main');
            }}
            onCancel={configStatus?.configured ? () => setCurrentScreen('main') : undefined}
          />
        ) : currentScreen === 'results' && session ? (
          <SessionResults
            session={session}
            onNewSession={() => {
              setSession(null);
              setCurrentScreen('main');
              triggerExtraction();
            }}
            onBackToQuestions={() => setCurrentScreen('main')}
          />
        ) : (
          <MainScreen
            session={session}
            activeTabInfo={activeTabInfo}
            detectedQuestions={detectedQuestions}
            activeQuestionIndex={activeQuestionIndex}
            setActiveQuestionIndex={setActiveQuestionIndex}
            onStartSession={handleStartSession}
            onPauseSession={handlePauseSession}
            onResumeSession={handleResumeSession}
            onStopSession={handleStopSession}
            onViewResults={() => setCurrentScreen('results')}
            onSolveQuestion={handleSolveQuestion}
            onConfirmSelection={handleConfirmSelection}
            onReorder={handleReorder}
            onSubmitAnswer={handleSubmitAnswer}
            onNextQuestion={handleNextQuestion}
            onResetSession={handleResetSession}
            isSolving={isSolving}
            autoPilot={autoPilot}
            autoPilotStatus={autoPilotStatus}
            onToggleAutoPilot={handleToggleAutoPilot}
          />
        )}
      </main>
    </div>
  );
};

