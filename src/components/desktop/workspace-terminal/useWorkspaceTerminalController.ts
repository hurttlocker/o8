'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  buildRepoStateScope,
  loadTabState,
  saveTabState,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { ORCHESTRATED_TAB_AUTO_ARCHIVE_MS } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
  WorkspaceTerminalProps,
} from '@/components/desktop/workspace-terminal/types';
import {
  buildWorkspaceLaneState,
  createWorkspaceTabId,
  generateLlmChatTabId,
} from '@/components/desktop/workspace-terminal/utils';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { buildTerminalTabHandle } from '@/components/desktop/workspace-terminal/terminal-imperative-handle';
import { canPreserveScopedTabs, computeRestoredTabs, loadInitialTabState, resetControllerRefs, shouldSkipRestoreKeyChange } from '@/components/desktop/workspace-terminal/terminal-restore';
import {
  buildChatSessionSnapshots,
  buildCommitCanvasTab,
  computeChatSessionSignature,
  computeCliChatSession,
  computeInspectorTab,
  computeLlmChatSession,
  buildLlmInjection,
  resolveActiveChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-session-ops';
import {
  archivePacket,
  buildHistoryChatTab,
  buildNewChatTab,
  buildNewLlmChatTab,
  buildPersistedState,
  computeCheckpointRestore,
  computeCloseTab,
  computeNewTerminalTab,
  flushPendingCliCommands,
  isAutoArchiveEligible,
  resolveRunCommandTarget,
  observeXtermHelperNames,
  startPreviewDrag,
  computeSaveCheckpoint,
  computeUpdatedChatMessages,
  computeUpdatedChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-tab-handlers';

type ControllerProps = WorkspaceTerminalProps;

export function useWorkspaceTerminalController(
  {
    stateScope,
    defaultTab,
    autoCreateDefaultTab = true,
    preferredRepo = null,
    splitCreated = false,
    availableRepos = [],
    onActiveChatSessionChange,
    onChatSessionsChange,
    onActiveLaneChange,
    onRepoScopeChange,
    onActiveRepoContextChange,
    onOpenRepoDiff,
    onPreviewDetected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalDetach,
    sendTerminalInput,
    termWsConnected,
  }: ControllerProps,
  ref: ForwardedRef<TerminalTabHandle>,
) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [previews, setPreviews] = useState<LocalhostPreview[]>([]);
  const [restoreCompletedKey, setRestoreCompletedKey] = useState<string | null>(null);
  const [previewHeight, setPreviewHeight] = useState(0.55);
  const [isDragging, setIsDragging] = useState(false);
  const [launchRequestKey, setLaunchRequestKey] = useState(0);

  const containerDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
  const pendingCliCommands = useRef<Map<string, string>>(new Map());
  const pendingRequestRef = useRef<Map<string, string>>(new Map());
  const restoredRef = useRef(false);
  const restoreSettledRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectedPortsRef = useRef<Set<number>>(new Set());
  const urlDetectionEnabledRef = useRef(false);
  const previousWsConnectedRef = useRef(false);
  const termWsConnectedRef = useRef(termWsConnected);
  const initialTerminalBootstrapRef = useRef(false);
  const restoreKeyRef = useRef<string | null>(null);
  const preferredRepoRef = useRef(preferredRepo);
  const reportedRepoScopeRef = useRef<string | null | undefined>(undefined);
  const chatSessionsChangeRef = useRef(onChatSessionsChange);
  const activeChatSessionChangeRef = useRef(onActiveChatSessionChange);
  const reportedChatSessionsSignatureRef = useRef('');
  const reportedActiveChatSessionKeyRef = useRef<string | null>(null);

  preferredRepoRef.current = preferredRepo;

  const stableRepoScope = !splitCreated && preferredRepo?.localPath
    ? buildRepoStateScope(preferredRepo.localPath)
    : null;
  const restoreKey = useMemo(
    () => [
      stateScope,
      defaultTab,
      splitCreated ? 'split' : 'shared',
      preferredRepo?.localPath ?? 'no-repo',
    ].join('::'),
    [defaultTab, preferredRepo?.localPath, splitCreated, stateScope],
  );
  const primaryRestoreSettled = restoreCompletedKey === restoreKey;
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !(tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci')),
    [tabs],
  );
  const effectiveActiveTabId = useMemo(
    () => visibleTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (visibleTabs[visibleTabs.length - 1]?.id ?? ''),
    [activeTabId, visibleTabs],
  );
  const activeTab = useMemo(
    () => visibleTabs.find((tab) => tab.id === effectiveActiveTabId) ?? null,
    [effectiveActiveTabId, visibleTabs],
  );
  const activeCheckpoint = activeTab?.kind === 'chat' ? activeTab.chatCheckpoints?.[0] : null;
  const activeRepo = activeTab?.repo ?? visibleTabs.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
  const activeLaneState = useMemo(
    () => buildWorkspaceLaneState(stateScope, activeTab, preferredRepo ?? null),
    [activeTab, preferredRepo, stateScope],
  );
  const activeRepoContext = useMemo<RegisteredRepo | null>(() => {
    if (!activeRepo) return null;
    return {
      ...activeRepo,
      branch: activeRepo.branch ?? preferredRepo?.branch ?? null,
      readiness: activeRepo.readiness ?? preferredRepo?.readiness ?? null,
      remoteUrl: activeRepo.remoteUrl ?? preferredRepo?.remoteUrl,
    };
  }, [activeRepo, preferredRepo]);

  const resolvePersistenceScope = useCallback((currentTabs: TerminalTab[]) => {
    const preferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    if (
      stableRepoScope
      && preferredRepoPath
      && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === preferredRepoPath)
    ) {
      return stableRepoScope;
    }
    return stateScope;
  }, [stableRepoScope, stateScope]);

  useEffect(() => {
    chatSessionsChangeRef.current = onChatSessionsChange;
    activeChatSessionChangeRef.current = onActiveChatSessionChange;
  }, [onActiveChatSessionChange, onChatSessionsChange]);

  useEffect(() => {
    termWsConnectedRef.current = termWsConnected;
  }, [termWsConnected]);

  useEffect(() => {
    const previousKey = restoreKeyRef.current;
    if (previousKey === restoreKey) return;
    restoreKeyRef.current = restoreKey;

    if (shouldSkipRestoreKeyChange(previousKey, restoreKey, restoreInFlightRef.current, tabsRef.current.length)) {
      return;
    }

    const shouldPreserve = canPreserveScopedTabs(tabsRef.current, preferredRepo?.localPath ?? null);
    resetControllerRefs({
      restoredRef, restoreSettledRef, previousWsConnectedRef, initialTerminalBootstrapRef,
      reportedRepoScopeRef, reportedChatSessionsSignatureRef, reportedActiveChatSessionKeyRef,
      detectedPortsRef, pendingCliCommands, pendingRequestRef, saveTimerRef,
    });
    if (shouldPreserve) {
      restoredRef.current = true;
      restoreSettledRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        setRestoreCompletedKey(restoreKey);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    urlDetectionEnabledRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      setPreviews([]);
      tabsRef.current = [];
      setTabs([]);
      setActiveTabId('');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [preferredRepo?.localPath, restoreKey]);

  useEffect(() => {
    const nextSessions = buildChatSessionSnapshots(
      visibleTabs, effectiveActiveTabId,
      preferredRepo?.localPath ?? '', preferredRepo?.branch ?? 'main',
      stableRepoScope, stateScope,
    );
    const signature = computeChatSessionSignature(nextSessions);
    if (reportedChatSessionsSignatureRef.current !== signature) {
      reportedChatSessionsSignatureRef.current = signature;
      chatSessionsChangeRef.current?.(nextSessions);
    }
    const nextActiveKey = resolveActiveChatSessionKey(nextSessions, reportedActiveChatSessionKeyRef.current);
    if (reportedActiveChatSessionKeyRef.current !== nextActiveKey) {
      reportedActiveChatSessionKeyRef.current = nextActiveKey;
      activeChatSessionChangeRef.current?.(nextActiveKey);
    }
  }, [effectiveActiveTabId, preferredRepo?.branch, preferredRepo?.localPath, stableRepoScope, stateScope, visibleTabs]);

  const persistTabsNow = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    const persisted = buildPersistedState(currentTabs, currentActiveId);
    const persistenceScope = resolvePersistenceScope(currentTabs);
    void saveTabState(persisted, persistenceScope);
    if (persistenceScope !== stateScope) {
      if (stateScope === 'tile-root') {
        void saveTabState(persisted, stateScope);
      } else {
        void saveTabState({ version: 1, activeTabId: '', tabs: [], savedAt: persisted.savedAt }, stateScope);
      }
    }
  }, [resolvePersistenceScope, stateScope]);

  const persistTabs = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistTabsNow(currentTabs, currentActiveId);
    }, 500);
  }, [persistTabsNow]);

  const requestTerminalForTab = useCallback((tabId: string, command?: string) => {
    const requestId = `workspace-${tabId}-${Date.now()}`;
    pendingRequestRef.current.set(requestId, tabId);
    if (command) {
      pendingCliCommands.current.set(tabId, command);
    }
    sendTerminalCreate(120, 30, requestId);
  }, [sendTerminalCreate]);

  useEffect(() => {
    tabsRef.current = tabs;
    if (restoreSettledRef.current) {
      persistTabs(tabs, effectiveActiveTabId);
    }
  }, [effectiveActiveTabId, persistTabs, tabs]);

  const createDefaultShellTab = useCallback((): TerminalTab => ({
    id: createWorkspaceTabId('terminal'), label: 'Shell', kind: 'terminal',
    tmuxSession: null, cliAgent: 'shell', createdAt: Date.now(), lastActivity: Date.now(),
  }), []);

  const createDefaultChatTab = useCallback((): TerminalTab => ({
    id: generateLlmChatTabId(), label: 'Assistant', kind: 'llm-chat',
    tmuxSession: null, repo: preferredRepoRef.current ?? undefined,
    linkedIssue: null, createdAt: Date.now(), lastActivity: Date.now(),
  }), []);

  const createDefaultOrchestratorTab = useCallback((): TerminalTab => ({
    id: createWorkspaceTabId('orchestrator'),
    label: 'Orchestrator',
    kind: 'orchestrator',
    tmuxSession: null,
    repo: preferredRepoRef.current ?? undefined,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  }), []);

  // Default tab set for a fresh LLM-chat workspace: Orchestrator FIRST
  // (it's the governance surface), Assistant (LLM chat) second.
  const createDefaultChatTabSet = useCallback((): TerminalTab[] => {
    return [createDefaultOrchestratorTab(), createDefaultChatTab()];
  }, [createDefaultOrchestratorTab, createDefaultChatTab]);

  const applyPersistedState = useCallback(async (saved: PersistedTabState, cancelled?: () => boolean) => {
    const result = await computeRestoredTabs(saved, {
      preferredRepo: preferredRepoRef.current,
      defaultTab,
      createDefaultChatTab,
    }, cancelled);
    if (!result) return false;

    tabsRef.current = result.tabs;
    setTabs(result.tabs);
    setActiveTabId(result.activeTabId);
    if (cancelled?.()) return false;

    if (termWsConnectedRef.current) {
      initialTerminalBootstrapRef.current = true;
      for (const sessionName of result.sessionsToAttach) {
        sendTerminalAttach(sessionName, 120, 30);
      }
      for (const deadTab of result.deadTerminalTabs) {
        if (cancelled?.()) return false;
        const restoreCommand = deadTab.repo?.localPath ? `cd ${deadTab.repo.localPath}` : undefined;
        requestTerminalForTab(deadTab.id, restoreCommand);
      }
    } else {
      initialTerminalBootstrapRef.current = false;
    }
    return result.restoredAny;
  }, [createDefaultChatTab, defaultTab, requestTerminalForTab, sendTerminalAttach]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    restoreInFlightRef.current = true;
    let cancelled = false;

    urlDetectionEnabledRef.current = false;
    const timer = window.setTimeout(() => {
      urlDetectionEnabledRef.current = true;
    }, 5000);

    const currentPreferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    const currentRestoreKey = restoreKeyRef.current ?? `${stateScope}::${defaultTab}::${splitCreated ? 'split' : 'shared'}::${currentPreferredRepoPath ?? 'no-repo'}`;

    void (async () => {
      try {
        const saved = await loadInitialTabState(
          { stateScope, defaultTab, splitCreated, preferredRepoPath: currentPreferredRepoPath },
          () => cancelled,
        );
        if (cancelled) return;

        if (saved) {
          await applyPersistedState(saved, () => cancelled);
          if (cancelled) return;
        } else if (autoCreateDefaultTab) {
          if (defaultTab === 'llm-chat') {
            const defaultTabs = createDefaultChatTabSet();
            tabsRef.current = defaultTabs;
            setTabs(defaultTabs);
            // Activate the Orchestrator tab first — it's index 0 in the set.
            setActiveTabId(defaultTabs[0].id);
          } else {
            const defaultShell = createDefaultShellTab();
            tabsRef.current = [defaultShell];
            setTabs([defaultShell]);
            setActiveTabId(defaultShell.id);
            if (termWsConnectedRef.current) {
              initialTerminalBootstrapRef.current = true;
              requestTerminalForTab(defaultShell.id);
            }
          }
        } else {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabId('');
        }
        restoreInFlightRef.current = false;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(currentRestoreKey);
      } catch {
        restoreInFlightRef.current = false;
        if (cancelled) return;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(restoreKeyRef.current ?? stateScope);
      }
    })();

    return () => {
      cancelled = true;
      restoreInFlightRef.current = false;
      window.clearTimeout(timer);
    };
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultChatTabSet, createDefaultShellTab, defaultTab, requestTerminalForTab, splitCreated, stateScope]);

  useEffect(() => {
    if (!termWsConnected || !restoreSettledRef.current || initialTerminalBootstrapRef.current) return;
    initialTerminalBootstrapRef.current = true;
    for (const tab of tabsRef.current) {
      if (tab.kind !== 'terminal') continue;
      if (tab.tmuxSession) {
        sendTerminalAttach(tab.tmuxSession, 120, 30);
        continue;
      }
      const restoreCommand = tab.repo?.localPath ? `cd ${tab.repo.localPath}` : undefined;
      requestTerminalForTab(tab.id, restoreCommand);
    }
  }, [requestTerminalForTab, sendTerminalAttach, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || !termWsConnected || splitCreated || !primaryRestoreSettled) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (stableRepoScope && preferredRepo?.localPath) {
          const saved = await loadTabState(stableRepoScope, preferredRepo.localPath);
          if (saved && saved.tabs.length > 0) {
            const restored = await applyPersistedState(saved);
            if (restored) return;
          }
        }
        if (!autoCreateDefaultTab) {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabId('');
          return;
        }
        if (defaultTab === 'llm-chat') {
          const defaultTabs = createDefaultChatTabSet();
          tabsRef.current = defaultTabs;
          setTabs(defaultTabs);
          setActiveTabId(defaultTabs[0].id);
          return;
        }
        const fallbackShell = createDefaultShellTab();
        tabsRef.current = [fallbackShell];
        setTabs([fallbackShell]);
        setActiveTabId(fallbackShell.id);
        if (termWsConnected) {
          requestTerminalForTab(fallbackShell.id);
        }
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultChatTabSet, createDefaultShellTab, defaultTab, preferredRepo?.localPath, primaryRestoreSettled, requestTerminalForTab, splitCreated, stableRepoScope, tabs.length, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || defaultTab !== 'llm-chat') return;
    const timer = window.setTimeout(() => {
      if (tabsRef.current.length > 0) return;
      const fallbacks = createDefaultChatTabSet();
      tabsRef.current = fallbacks;
      setTabs(fallbacks);
      setActiveTabId(fallbacks[0].id);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [createDefaultChatTabSet, defaultTab, tabs.length]);

  useEffect(() => {
    const wasConnected = previousWsConnectedRef.current;
    previousWsConnectedRef.current = termWsConnected;
    if (!termWsConnected || !wasConnected || !restoredRef.current) return;
    for (const tab of tabsRef.current) {
      if (tab.kind === 'terminal' && tab.tmuxSession) {
        sendTerminalAttach(tab.tmuxSession, 120, 30);
      }
    }
  }, [sendTerminalAttach, termWsConnected]);

  // Migration: if restored state is missing an Orchestrator tab, inject one
  // at the front. Ensures existing users get the new tab automatically and
  // don't have to manually add it.
  useEffect(() => {
    if (defaultTab !== 'llm-chat') return;
    if (tabs.length === 0) return;
    const hasOrchestrator = tabs.some((tab) => tab.kind === 'orchestrator');
    if (hasOrchestrator) return;
    const orchestratorTab = createDefaultOrchestratorTab();
    const nextTabs = [orchestratorTab, ...tabs];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    // Don't steal focus from whatever the user was on — just inject the tab.
  }, [createDefaultOrchestratorTab, defaultTab, tabs]);

  const handleSessionCreated = useCallback((sessionName: string, requestId?: string) => {
    const directTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
    if (requestId && !directTabId) return false;
    if (requestId) pendingRequestRef.current.delete(requestId);

    let claimed = false;
    setTabs((previous) => {
      const pendingIndex = directTabId
        ? previous.findIndex((tab) => tab.id === directTabId && tab.kind === 'terminal' && tab.tmuxSession === null)
        : previous.findIndex((tab) => tab.kind === 'terminal' && tab.tmuxSession === null);
      if (pendingIndex < 0) return previous;
      const updated = [...previous];
      const tab = updated[pendingIndex];
      updated[pendingIndex] = { ...tab, tmuxSession: sessionName };
      claimed = true;
      return updated;
    });
    if (!claimed && requestId && directTabId) {
      sendTerminalDetach(sessionName);
    }
    return claimed;
  }, [sendTerminalDetach]);

  const openWorkspaceCliChatSession = useCallback((options: Parameters<TerminalTabHandle['openCliChatSession']>[0]) => {
    const result = computeCliChatSession(options, tabsRef.current, activeTabId);
    tabsRef.current = result.tabs;
    setTabs(result.tabs);
    setActiveTabId(result.activeTabId);
    if (result.needsPersist) persistTabsNow(result.tabs, result.activeTabId);
    return result.activeTabId;
  }, [activeTabId, persistTabsNow]);

  const openWorkspaceLlmChatSession = useCallback((options: {
    repo?: RegisteredRepo;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
  }) => {
    const result = computeLlmChatSession(options, tabsRef.current, activeTabId);
    if (result.updatedTabId) {
      const injection = buildLlmInjection(options);
      setTabs((previous) => previous.map((tab) => (
        tab.id === result.updatedTabId ? { ...tab, label: options.label ?? tab.label, llmDraftInjection: injection ?? tab.llmDraftInjection } : tab
      )));
    } else if (result.newTab) {
      setTabs((previous) => [...previous, result.newTab!]);
    }
    setActiveTabId(result.activeTabId);
    return result.activeTabId;
  }, [activeTabId]);

  const openWorkspaceInspectorTab = useCallback((canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => {
    const result = computeInspectorTab(canvasTab, tabsRef.current, options);
    if (result.updatedTabId) {
      setTabs((previous) => previous.map((tab) => (
        tab.id === result.updatedTabId
          ? { ...tab, label: canvasTab.label, canvasTab, repo: options?.repo ?? tab.repo, lastActivity: Date.now() }
          : tab
      )));
    } else if (result.newTab) {
      setTabs((previous) => [...previous, result.newTab!]);
    }
    if (result.activeTabId !== null) {
      setActiveTabId(result.activeTabId);
    }
    return result.updatedTabId ?? result.newTab?.id ?? '';
  }, []);

  const handleOpenWorkspaceCommitTab = useCallback((hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => {
    const { canvasTab, repo: resolvedRepo } = buildCommitCanvasTab(hash, meta, repo);
    openWorkspaceInspectorTab(canvasTab, { repo: resolvedRepo });
  }, [openWorkspaceInspectorTab]);

  useImperativeHandle(ref, () => buildTerminalTabHandle({
    tabsRef,
    panelRefs,
    detectedPortsRef,
    urlDetectionEnabledRef,
    restoreSettledRef,
    pendingRequestRef,
    activeTabId,
    stateScope,
    preferredRepo,
    setTabs,
    setPreviews,
    setActiveTabId,
    onPreviewDetected,
    onOpenRepoDiff,
    handleSessionCreated,
    openWorkspaceCliChatSession,
    openWorkspaceLlmChatSession,
    openWorkspaceInspectorTab,
    persistTabsNow,
    sendTerminalDetach,
  }), [activeTabId, handleSessionCreated, onOpenRepoDiff, onPreviewDetected, openWorkspaceCliChatSession, openWorkspaceInspectorTab, openWorkspaceLlmChatSession, persistTabsNow, preferredRepo, sendTerminalDetach, stateScope]);

  const handleRegisterRepo = useCallback((localPath: string) => {
    fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', localPath }),
    }).catch(() => undefined);
  }, []);

  const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
    const result = computeNewTerminalTab(agentId, repo);
    if (!result.newTab) return;
    if (result.cliCommand) {
      pendingCliCommands.current.set(result.newTab.id, result.cliCommand);
    }
    setTabs((previous) => [...previous, result.newTab!]);
    setActiveTabId(result.activeTabId);
    requestTerminalForTab(result.newTab.id, result.cliCommand ?? undefined);
  }, [requestTerminalForTab]);

  const handleNewChatTab = useCallback((runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => {
    const newTab = buildNewChatTab(runtime, repo);
    setTabs((previous) => [...previous, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleNewLLMChatTab = useCallback((repo?: RegisteredRepo) => {
    const newTab = buildNewLlmChatTab(repo ?? preferredRepo ?? undefined);
    setTabs((previous) => {
      const nextTabs = [...previous, newTab];
      persistTabsNow(nextTabs, newTab.id);
      return nextTabs;
    });
    setActiveTabId(newTab.id);
  }, [persistTabsNow, preferredRepo]);

  const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatMessages(tab, messages) : tab
    )));
  }, []);

  const handleUpdateLlmSummary = useCallback((tabId: string, summary: string | null) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.llmSummary === summary) return tab;
        changed = true;
        return { ...tab, llmSummary: summary };
      });
      return changed ? next : prev;
    });
  }, []);

  const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatSessionKey(tab, sessionKey) : tab
    )));
  }, []);

  const handleUpdateChatModel = useCallback((tabId: string, modelId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, chatModel: modelId } : tab
    )));
  }, []);

  const handleUpdateLinkedIssue = useCallback((tabId: string, linkedIssue: TerminalTab['linkedIssue']) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, linkedIssue } : tab
    )));
  }, []);

  const handleSaveCheckpoint = useCallback((tabId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeSaveCheckpoint(tab) : tab
    )));
  }, []);

  const handleRestoreLatestCheckpoint = useCallback((tabId: string) => {
    const result = computeCheckpointRestore(tabsRef.current, tabId);
    if (!result.newTab) return;
    setTabs((previous) => [...previous, result.newTab!]);
    setActiveTabId(result.activeTabId);
  }, []);

  const handleConsumeChatDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.chatDraftInjection?.id === injectionId
        ? { ...tab, chatDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleConsumeLlmDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.llmDraftInjection?.id === injectionId
        ? { ...tab, llmDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleRunCommandInTerminal = useCallback((command: string) => {
    const target = resolveRunCommandTarget(tabs);
    if (target.kind === 'existing-shell') {
      sendTerminalInput(target.tmuxSession!, command + '\n');
    } else if (target.kind === 'pending-shell') {
      pendingCliCommands.current.set(target.pendingTabId!, command);
      setActiveTabId(target.pendingTabId!);
    } else {
      setTabs((previous) => [...previous, target.newTab!]);
      setActiveTabId(target.newTab!.id);
      requestTerminalForTab(target.newTab!.id, command);
    }
  }, [requestTerminalForTab, sendTerminalInput, tabs]);

  const handleCloseTab = useCallback((tabId: string) => {
    const result = computeCloseTab(tabsRef.current, tabId, activeTabId);
    if (!result) return;
    if (result.detachedSession) {
      sendTerminalDetach(result.detachedSession);
      panelRefs.current.delete(result.detachedSession);
    }
    pendingCliCommands.current.delete(tabId);
    for (const [requestId, pendingTabId] of pendingRequestRef.current) {
      if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
    }
    setTabs(result.remaining);
    if (result.nextActiveId !== null) setActiveTabId(result.nextActiveId);
    setPreviews((prev) => {
      const toRemove = prev.filter((p) => p.tabId === tabId);
      toRemove.forEach((p) => detectedPortsRef.current.delete(p.port));
      return prev.filter((p) => p.tabId !== tabId);
    });
  }, [activeTabId, sendTerminalDetach]);

  const archiveWorkspaceTab = useCallback((tabId: string, packetId?: string | null) => {
    handleCloseTab(tabId);
    archivePacket(packetId);
  }, [handleCloseTab]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.id === effectiveActiveTabId || !isAutoArchiveEligible(tab)) continue;
      const delayMs = Math.max(0, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS - Math.max(0, now - tab.lastActivity));
      timers.set(tab.id, window.setTimeout(() => {
        archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
      }, delayMs));
    }
    return () => { timers.forEach((id) => window.clearTimeout(id)); };
  }, [archiveWorkspaceTab, effectiveActiveTabId, tabs]);

  useEffect(() => {
    flushPendingCliCommands(tabs, pendingCliCommands.current, sendTerminalInput);
  }, [sendTerminalInput, tabs]);

  const handleDragStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startPreviewDrag(containerDivRef.current, setPreviewHeight, setIsDragging);
  }, []);

  useEffect(() => {
    onActiveLaneChange?.(activeLaneState);
  }, [activeLaneState, onActiveLaneChange]);

  useEffect(() => {
    if (!containerDivRef.current) return undefined;
    return observeXtermHelperNames(containerDivRef.current, stateScope);
  }, [stateScope]);

  useEffect(() => {
    const nextRepoScope = activeRepo?.localPath ?? preferredRepo?.localPath ?? null;
    if (reportedRepoScopeRef.current === nextRepoScope) return;
    reportedRepoScopeRef.current = nextRepoScope;
    onRepoScopeChange?.(nextRepoScope);
  }, [activeRepo?.localPath, onRepoScopeChange, preferredRepo?.localPath]);

  useEffect(() => {
    onActiveRepoContextChange?.(activeRepoContext);
  }, [activeRepoContext, onActiveRepoContextChange]);

  const handleReorderTabs = useCallback((draggedId: string, dropTargetId: string) => {
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === draggedId);
      const toIdx = prev.findIndex((t) => t.id === dropTargetId);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setTabs((previous) => previous.map((tab) => (
      tab.id === id && tab.unseen ? { ...tab, unseen: false } : tab
    )));
  }, []);

  const handleClosePreview = useCallback((id: string) => {
    setPreviews((previous) => {
      const removed = previous.find((preview) => preview.id === id);
      if (removed) {
        detectedPortsRef.current.delete(removed.port);
      }
      return previous.filter((preview) => preview.id !== id);
    });
  }, []);

  const handleOpenHistoryChat = useCallback((
    currentTab: TerminalTab,
    historyTabId: string,
    title: string,
    historyRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => {
    const newTab = buildHistoryChatTab(currentTab, historyTabId, title, historyRepo);
    setTabs((previous) => {
      if (previous.some((tab) => tab.id === historyTabId)) {
        setActiveTabId(historyTabId);
        return previous;
      }
      return [...previous, newTab];
    });
    setActiveTabId(historyTabId);
  }, []);

  return {
    activeCheckpoint,
    activeRepo,
    activeTab,
    containerDivRef,
    effectiveActiveTabId,
    handleClosePreview,
    handleCloseTab,
    handleConsumeChatDraftInjection,
    handleConsumeLlmDraftInjection,
    handleDragStart,
    handleNewChatTab,
    handleNewLLMChatTab,
    handleNewTab,
    handleOpenHistoryChat,
    handleReorderTabs,
    handleOpenWorkspaceCommitTab,
    handleRegisterRepo,
    handleRestoreLatestCheckpoint,
    handleRunCommandInTerminal,
    handleSaveCheckpoint,
    handleSelectTab,
    handleUpdateChatMessages,
    handleUpdateChatModel,
    handleUpdateChatSessionKey,
    handleUpdateLinkedIssue,
    handleUpdateLlmSummary,
    isDragging,
    launchRequestKey,
    panelRefs,
    previews,
    previewHeight,
    primaryRestoreSettled,
    restoreSettledRef,
    setLaunchRequestKey,
    tabs,
    termWsConnected,
    visibleTabs,
  };
}
