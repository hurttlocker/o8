'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  buildRepoStateScope,
  checkAliveSessions,
  formatPersistedRuntimeSessionKey,
  loadLiveRuntimeSessionKeys,
  loadTabState,
  saveTabState,
  stripPersistedRuntimeSessionKey,
  type PersistedChatCheckpoint,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  adHocLaneTitle,
  laneDisplayTitle,
} from '@/lib/orchestrator/display';
import {
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { ANSI_RE, CLAUDE_CLI_MODELS, CLI_AGENTS, CODEX_CLI_MODELS, IGNORED_PORTS, LOCALHOST_RE, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
  WorkspaceTerminalProps,
} from '@/components/desktop/workspace-terminal/types';
import {
  buildCheckpointLabel,
  buildWorkspaceLaneState,
  claimWorkspaceTabId,
  createWorkspaceTabId,
  fallbackWorkspaceChatSessionKey,
  formatWorkspaceChatSessionKey,
  generateLlmChatTabId,
  isAgentRuntimeTab,
  normalizeWorkspaceChatSessionKey,
  packetStatusFromSupervisorStatus,
  repoSlugFromRemote,
  resolveWorkspaceChatLaneStatus,
  sameOrchestrationPacketBadge,
  sameTranscriptMessages,
} from '@/components/desktop/workspace-terminal/utils';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';

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

    const nextPreferredRepoPath = preferredRepo?.localPath ?? null;
    const currentTabs = tabsRef.current;
    const hasOrchestratedTabs = currentTabs.some((tab) => Boolean(tab.orchestrationPacket));
    const canPreserveScopedTabs = previousKey !== null
      && currentTabs.length > 0
      && (
        hasOrchestratedTabs
        || (
          nextPreferredRepoPath
          && currentTabs.some((tab) => tab.repo?.localPath === nextPreferredRepoPath)
          && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === nextPreferredRepoPath)
        )
      );

    if (previousKey === null) return;

    const previousScope = previousKey.split('::')[0];
    const nextScope = restoreKey.split('::')[0];
    if (restoreInFlightRef.current && previousScope === nextScope && currentTabs.length === 0) {
      return;
    }

    restoredRef.current = false;
    restoreSettledRef.current = false;
    previousWsConnectedRef.current = false;
    initialTerminalBootstrapRef.current = false;
    reportedRepoScopeRef.current = undefined;
    reportedChatSessionsSignatureRef.current = '';
    reportedActiveChatSessionKeyRef.current = null;
    detectedPortsRef.current.clear();
    pendingCliCommands.current.clear();
    pendingRequestRef.current.clear();
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (canPreserveScopedTabs) {
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
    const preferredLocalPath = preferredRepo?.localPath ?? '';
    const preferredBranch = preferredRepo?.branch ?? 'main';
    const nextSessions: MobileInboxSnapshot['sessions'] = visibleTabs
      .filter(isAgentRuntimeTab)
      .map((tab) => {
        const runtime = tab.chatRuntime;
        const prefixedKey = normalizeWorkspaceChatSessionKey(runtime, tab.chatSessionKey)
          ?? fallbackWorkspaceChatSessionKey(runtime, tab.id, stableRepoScope ?? stateScope);
        const repoSlug = repoSlugFromRemote(tab.repo?.remoteUrl);
        const latestMessage = [...(tab.chatMessages ?? [])].reverse().find((entry) => entry.role === 'assistant' || entry.role === 'user');
        const hasLiveSession = Boolean(normalizeWorkspaceChatSessionKey(runtime, tab.chatSessionKey));
        const laneTitle = laneDisplayTitle(tab.orchestrationPacket, tab.kind);
        const laneStatus = resolveWorkspaceChatLaneStatus(tab);
        return {
          id: prefixedKey,
          name: laneTitle,
          squadId: 'workspace',
          runtime,
          model: tab.chatModel ?? (runtime === 'claude-code' ? 'claude-code' : 'codex'),
          status: laneStatus === 'blocked'
            ? 'blocked'
            : laneStatus === 'launching'
              ? 'waiting'
              : tab.id === effectiveActiveTabId && hasLiveSession
                ? 'running'
                : hasLiveSession
                  ? 'reviewing'
                  : 'idle',
          currentTask: tab.orchestrationPacket?.title ?? latestMessage?.text?.trim() ?? (hasLiveSession ? '' : 'Idle'),
          workspace: tab.repo?.localPath ?? preferredLocalPath,
          branch: tab.repo?.branch ?? preferredBranch,
          sessionKey: prefixedKey,
          approvalStatus: 'none' as const,
          lastEventAt: new Date(tab.lastActivity).toISOString(),
          context: { usedPercent: 0, trend: 'stable' as const },
          alerts: 0,
          surfaceLabel: laneTitle,
          isCurrentSession: tab.id === effectiveActiveTabId,
          orchestrationPacket: tab.orchestrationPacket ?? null,
          runtimeSurface: {
            id: prefixedKey,
            runtime,
            kind: 'chat-session' as const,
            ownership: 'owned' as const,
            title: laneTitle,
            cwd: tab.repo?.localPath ?? preferredLocalPath,
            branch: tab.repo?.branch ?? preferredBranch,
            sourceLabel: hasLiveSession
              ? 'Workspace lane'
              : tab.supervisorStatus
                ? `Workspace lane (${tab.supervisorStatus})`
                : 'Workspace lane restored without a live runtime session',
            capabilities: {
              attach: false,
              readTail: true,
              sendInput: hasLiveSession,
              interrupt: hasLiveSession,
              resize: false,
              diffContext: true,
              reviewContext: true,
            },
            reviewContext: repoSlug ? {
              repoSlug,
              branch: tab.repo?.branch ?? preferredBranch,
            } : undefined,
          },
        };
      });

    const signature = JSON.stringify(nextSessions.map((session) => ({
      sessionKey: session.sessionKey,
      status: session.status,
      name: session.name,
      currentTask: session.currentTask,
      workspace: session.workspace,
      branch: session.branch,
      lastEventAt: session.lastEventAt,
    })));
    if (reportedChatSessionsSignatureRef.current !== signature) {
      reportedChatSessionsSignatureRef.current = signature;
      chatSessionsChangeRef.current?.(nextSessions);
    }
    const activeChat = nextSessions.find((session) => session.isCurrentSession)
      ?? nextSessions.find((session) => session.sessionKey === reportedActiveChatSessionKeyRef.current)
      ?? nextSessions[0]
      ?? null;
    const nextActiveSessionKey = activeChat?.sessionKey ?? null;
    if (reportedActiveChatSessionKeyRef.current !== nextActiveSessionKey) {
      reportedActiveChatSessionKeyRef.current = nextActiveSessionKey;
      activeChatSessionChangeRef.current?.(nextActiveSessionKey);
    }
  }, [effectiveActiveTabId, preferredRepo?.branch, preferredRepo?.localPath, stableRepoScope, stateScope, visibleTabs]);

  const serializePersistedTabs = useCallback((currentTabs: TerminalTab[]) => (
    currentTabs
      .filter((tab) => !(tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci'))
      .map((tab) => ({
        id: tab.id,
        label: tab.label,
        kind: tab.kind,
        cliAgent: tab.cliAgent ?? 'shell',
        repoName: tab.repo?.name,
        repoPath: tab.repo?.localPath,
        tmuxSession: tab.tmuxSession ?? undefined,
        chatRuntime: tab.chatRuntime,
        chatSessionKey: tab.chatSessionKey,
        chatModel: tab.chatModel,
        chatContinueLatest: tab.chatContinueLatest,
        chatCheckpoints: tab.chatCheckpoints,
        linkedIssue: tab.linkedIssue ?? undefined,
        orchestrationPacket: tab.orchestrationPacket ?? undefined,
        supervisorStatus: tab.supervisorStatus ?? undefined,
        autoArchiveOnIdle: tab.autoArchiveOnIdle ?? undefined,
        canvasTab: tab.canvasTab ? {
          id: tab.canvasTab.id,
          kind: tab.canvasTab.kind,
          label: tab.canvasTab.label,
          resourceId: tab.canvasTab.resourceId,
          meta: tab.canvasTab.meta,
        } : undefined,
      }))
  ), []);

  const persistTabsNow = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    const persistableTabs = serializePersistedTabs(currentTabs);
    const nextActiveId = persistableTabs.length === 0
      ? ''
      : persistableTabs.some((tab) => tab.id === currentActiveId)
        ? currentActiveId
        : (persistableTabs[persistableTabs.length - 1]?.id ?? '');
    const persisted: PersistedTabState = {
      version: 1,
      activeTabId: nextActiveId,
      tabs: persistableTabs,
      savedAt: new Date().toISOString(),
    };
    const persistenceScope = resolvePersistenceScope(currentTabs);
    void saveTabState(persisted, persistenceScope);
    if (persistenceScope !== stateScope) {
      if (stateScope === 'tile-root') {
        void saveTabState(persisted, stateScope);
      } else {
        void saveTabState({ version: 1, activeTabId: '', tabs: [], savedAt: persisted.savedAt }, stateScope);
      }
    }
  }, [resolvePersistenceScope, serializePersistedTabs, stateScope]);

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

  const createDefaultShellTab = useCallback((): TerminalTab => {
    const now = Date.now();
    return {
      id: createWorkspaceTabId('terminal'),
      label: 'Shell',
      kind: 'terminal',
      tmuxSession: null,
      cliAgent: 'shell',
      createdAt: now,
      lastActivity: now,
    };
  }, []);

  const createDefaultChatTab = useCallback((): TerminalTab => {
    const now = Date.now();
    return {
      id: generateLlmChatTabId(),
      label: 'Chat',
      kind: 'llm-chat',
      tmuxSession: null,
      repo: preferredRepoRef.current ?? undefined,
      linkedIssue: null,
      createdAt: now,
      lastActivity: now,
    };
  }, []);

  const applyPersistedState = useCallback(async (saved: PersistedTabState, cancelled?: () => boolean) => {
    const tmuxNames = saved.tabs.map((tab) => tab.tmuxSession).filter(Boolean) as string[];
    const needsLivenessCheck = saved.tabs.some((tab) => {
      const kind = tab.kind ?? 'terminal';
      if (kind === 'terminal') return true;
      if (kind === 'chat' && !tab.orchestrationPacket) return true;
      return false;
    });

    let alive: Set<string>;
    let liveRuntimeSessionKeys: Set<import('@/lib/terminal/tab-state').PersistedRuntimeSessionKey>;

    if (needsLivenessCheck) {
      try {
        const result = await Promise.race([
          Promise.all([checkAliveSessions(tmuxNames), loadLiveRuntimeSessionKeys()]),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
        ]);
        if (result === 'timeout') {
          alive = new Set(tmuxNames);
          liveRuntimeSessionKeys = new Set();
        } else {
          [alive, liveRuntimeSessionKeys] = result;
        }
      } catch {
        alive = new Set(tmuxNames);
        liveRuntimeSessionKeys = new Set();
      }
    } else {
      alive = new Set(tmuxNames);
      const optimisticKeys = saved.tabs
        .map((tab) => formatPersistedRuntimeSessionKey(tab.chatRuntime, tab.chatSessionKey))
        .filter((key): key is import('@/lib/terminal/tab-state').PersistedRuntimeSessionKey => key !== null);
      liveRuntimeSessionKeys = new Set(optimisticKeys);
    }
    if (cancelled?.()) return false;

    const currentPreferredRepo = preferredRepoRef.current;
    const restoredTabs: TerminalTab[] = [];
    const sessionsToAttach: string[] = [];
    const seenRuntimeChats = new Set<string>();
    const seenTerminalSessions = new Set<string>();
    const seenTabIds = new Set<string>();
    let restoredActiveTabId: string | null = null;

    for (const savedTab of saved.tabs) {
      if (cancelled?.()) return false;
      const now = Date.now();
      const tabKind = savedTab.kind ?? 'terminal';

      if (tabKind === 'llm-chat') {
        const tabId = claimWorkspaceTabId('llm-chat', seenTabIds, savedTab.id);
        restoredTabs.push({
          id: tabId,
          label: savedTab.label,
          kind: 'llm-chat',
          tmuxSession: null,
          repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
          linkedIssue: savedTab.linkedIssue ?? null,
          createdAt: now,
          lastActivity: now,
        });
        if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
        continue;
      }

      if (tabKind === 'chat') {
        const prefixedSessionKey = formatPersistedRuntimeSessionKey(savedTab.chatRuntime, savedTab.chatSessionKey);
        if (prefixedSessionKey && seenRuntimeChats.has(`${prefixedSessionKey}:${savedTab.repoPath ?? ''}`)) {
          continue;
        }
        if (prefixedSessionKey) {
          seenRuntimeChats.add(`${prefixedSessionKey}:${savedTab.repoPath ?? ''}`);
        }
        const liveSessionKey = prefixedSessionKey && liveRuntimeSessionKeys.has(prefixedSessionKey)
          ? stripPersistedRuntimeSessionKey(savedTab.chatRuntime, savedTab.chatSessionKey)
          : undefined;
        const tabId = claimWorkspaceTabId('chat', seenTabIds, savedTab.id);
        restoredTabs.push({
          id: tabId,
          label: savedTab.label,
          kind: 'chat',
          tmuxSession: null,
          chatRuntime: savedTab.chatRuntime,
          chatSessionKey: liveSessionKey,
          chatModel: savedTab.chatModel,
          chatContinueLatest: liveSessionKey ? savedTab.chatContinueLatest : false,
          chatCheckpoints: savedTab.chatCheckpoints ?? [],
          repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
          linkedIssue: savedTab.linkedIssue ?? null,
          orchestrationPacket: savedTab.orchestrationPacket ?? null,
          supervisorStatus: savedTab.supervisorStatus ?? null,
          autoArchiveOnIdle: savedTab.autoArchiveOnIdle ?? false,
          createdAt: now,
          lastActivity: now,
          chatMessages: [],
        });
        if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
        continue;
      }

      if (tabKind === 'canvas' && savedTab.canvasTab) {
        if (savedTab.canvasTab.kind === 'ci') continue;
        const tabId = claimWorkspaceTabId('canvas', seenTabIds, savedTab.id);
        restoredTabs.push({
          id: tabId,
          label: savedTab.label,
          kind: 'canvas',
          tmuxSession: null,
          repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
          canvasTab: {
            id: savedTab.canvasTab.id,
            kind: savedTab.canvasTab.kind as TerminalTab['canvasTab'] extends { kind: infer T } ? T : never,
            label: savedTab.canvasTab.label,
            resourceId: savedTab.canvasTab.resourceId,
            meta: savedTab.canvasTab.meta,
          },
          createdAt: now,
          lastActivity: now,
        });
        if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
        continue;
      }

      const tabId = claimWorkspaceTabId('terminal', seenTabIds, savedTab.id);
      if (savedTab.tmuxSession && alive.has(savedTab.tmuxSession) && !seenTerminalSessions.has(savedTab.tmuxSession)) {
        seenTerminalSessions.add(savedTab.tmuxSession);
        restoredTabs.push({
          id: tabId,
          label: savedTab.label,
          kind: 'terminal',
          tmuxSession: savedTab.tmuxSession,
          cliAgent: savedTab.cliAgent,
          repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
          createdAt: now,
          lastActivity: now,
        });
        sessionsToAttach.push(savedTab.tmuxSession);
      } else {
        restoredTabs.push({
          id: tabId,
          label: savedTab.label,
          kind: 'terminal',
          tmuxSession: null,
          cliAgent: 'shell',
          repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
          createdAt: now,
          lastActivity: now,
        });
      }
      if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
    }

    const restoredActiveTab = restoredActiveTabId ? restoredTabs.find((tab) => tab.id === restoredActiveTabId) : null;
    const effectiveRestoredActiveId = restoredActiveTab?.kind === 'canvas' ? null : restoredActiveTabId;
    let nextActiveId = '';

    if (defaultTab === 'llm-chat') {
      const restoredChat = restoredTabs.find((tab) => tab.kind === 'llm-chat');
      if (restoredChat) {
        nextActiveId = effectiveRestoredActiveId ?? restoredChat.id;
        tabsRef.current = restoredTabs;
        setTabs(restoredTabs);
        setActiveTabId(nextActiveId);
      } else if (restoredTabs.length > 0) {
        const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
        nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTabs[0]?.id ?? '';
        tabsRef.current = restoredTabs;
        setTabs(restoredTabs);
        setActiveTabId(nextActiveId);
      } else {
        const defaultChat = createDefaultChatTab();
        const nextTabs = [defaultChat, ...restoredTabs];
        nextActiveId = defaultChat.id;
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveTabId(nextActiveId);
      }
    } else {
      const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
      const restoredTerminal = restoredTabs.find((tab) => tab.kind === 'terminal');
      nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTerminal?.id ?? restoredTabs[0]?.id ?? '';
      tabsRef.current = restoredTabs;
      setTabs(restoredTabs);
      setActiveTabId(nextActiveId);
    }
    if (cancelled?.()) return false;

    if (termWsConnectedRef.current) {
      initialTerminalBootstrapRef.current = true;
      for (const sessionName of sessionsToAttach) {
        sendTerminalAttach(sessionName, 120, 30);
      }
      const deadTerminalTabs = restoredTabs.filter((tab) => tab.kind === 'terminal' && tab.tmuxSession === null);
      for (const deadTab of deadTerminalTabs) {
        if (cancelled?.()) return false;
        const restoreCommand = deadTab.repo?.localPath ? `cd ${deadTab.repo.localPath}` : undefined;
        requestTerminalForTab(deadTab.id, restoreCommand);
      }
    } else {
      initialTerminalBootstrapRef.current = false;
    }
    return restoredTabs.length > 0;
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

    void (async () => {
      try {
        let saved = splitCreated ? null : await loadTabState(stateScope, null);
        if (cancelled) return;
        const currentPreferredRepoPath = preferredRepoRef.current?.localPath ?? null;
        const currentStableRepoScope = !splitCreated && currentPreferredRepoPath
          ? buildRepoStateScope(currentPreferredRepoPath)
          : null;
        const savedRepoPaths = saved
          ? Array.from(new Set(saved.tabs.map((tab) => tab.repoPath).filter((value): value is string => Boolean(value))))
          : [];
        const savedHasOrchestratedTabs = Boolean(saved?.tabs.some((tab) => tab.orchestrationPacket));
        const savedMatchesPreferredRepo = !currentPreferredRepoPath
          || savedRepoPaths.length === 0
          || savedRepoPaths.includes(currentPreferredRepoPath);

        if (!splitCreated && (!saved || saved.tabs.length === 0 || (!savedMatchesPreferredRepo && !savedHasOrchestratedTabs)) && currentStableRepoScope) {
          saved = await loadTabState(currentStableRepoScope, currentPreferredRepoPath);
          if (cancelled) return;
        }

        const currentRestoreKey = restoreKeyRef.current ?? `${stateScope}::${defaultTab}::${splitCreated ? 'split' : 'shared'}::${currentPreferredRepoPath ?? 'no-repo'}`;

        if (saved && saved.tabs.length > 0) {
          await applyPersistedState(saved, () => cancelled);
          if (cancelled) return;
          restoreInFlightRef.current = false;
          restoreSettledRef.current = true;
          setRestoreCompletedKey(currentRestoreKey);
        } else if (autoCreateDefaultTab) {
          if (cancelled) return;
          if (defaultTab === 'llm-chat') {
            const defaultChat = createDefaultChatTab();
            tabsRef.current = [defaultChat];
            setTabs([defaultChat]);
            setActiveTabId(defaultChat.id);
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
          restoreInFlightRef.current = false;
          restoreSettledRef.current = true;
          setRestoreCompletedKey(currentRestoreKey);
        } else {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabId('');
          restoreInFlightRef.current = false;
          restoreSettledRef.current = true;
          setRestoreCompletedKey(currentRestoreKey);
        }
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
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultShellTab, defaultTab, requestTerminalForTab, splitCreated, stateScope]);

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
          const fallbackChat = createDefaultChatTab();
          tabsRef.current = [fallbackChat];
          setTabs([fallbackChat]);
          setActiveTabId(fallbackChat.id);
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
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createDefaultShellTab, defaultTab, preferredRepo?.localPath, primaryRestoreSettled, requestTerminalForTab, splitCreated, stableRepoScope, tabs.length, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || defaultTab !== 'llm-chat') return;
    const timer = window.setTimeout(() => {
      if (tabsRef.current.length > 0) return;
      const fallback = createDefaultChatTab();
      tabsRef.current = [fallback];
      setTabs([fallback]);
      setActiveTabId(fallback.id);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [createDefaultChatTab, defaultTab, tabs.length]);

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
    const currentTabs = tabsRef.current;
    const currentActiveTab = currentTabs.find((tab) => tab.id === activeTabId);
    const targetRuntime = options.targetSessionKey?.startsWith('codex:')
      || options.targetSessionKey?.startsWith('codex-owned:')
      || options.targetSessionKey?.startsWith('codex-discovered:')
      || options.targetSessionKey?.startsWith('codex-live:')
      ? 'codex'
      : options.targetSessionKey?.startsWith('claude-code:')
        ? 'claude-code'
        : null;
    const resolvedRuntime = options.runtime
      ?? targetRuntime
      ?? (isAgentRuntimeTab(currentActiveTab) ? currentActiveTab.chatRuntime : (options.createNew ? 'codex' : 'claude-code'));
    const normalizedTargetSessionKey = options.targetSessionKey
      ? normalizeWorkspaceChatSessionKey(resolvedRuntime, options.targetSessionKey)
      : null;

    const targetedExisting = options.createNew || !options.targetSessionKey
      ? null
      : currentTabs.find((tab) => (
          tab.kind === 'chat'
          && formatWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey) === normalizedTargetSessionKey
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));
    const activeExisting = currentTabs.find((tab) => (
      tab.id === activeTabId
      && tab.kind === 'chat'
      && tab.chatRuntime === resolvedRuntime
      && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
    ));
    const matchingExisting = options.createNew
      ? null
      : targetedExisting
        ?? activeExisting
        ?? currentTabs.find((tab) => (
          tab.kind === 'chat'
          && tab.chatRuntime === resolvedRuntime
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));
    const injection = options.initialText ? {
      id: `workspace-chat-injection-${Date.now()}`,
      text: options.initialText,
      reason: options.draftReason,
      autoSend: options.autoSend,
    } : undefined;

    if (matchingExisting) {
      const resolvedTabId = matchingExisting.id;
      const nextTabs = currentTabs.map((tab) => (
        tab.id === resolvedTabId
          ? {
              ...tab,
              label: options.label ?? options.orchestrationPacket?.title ?? tab.label,
              chatSessionKey: normalizedTargetSessionKey ?? tab.chatSessionKey,
              chatModel: options.modelId ?? tab.chatModel,
              chatContinueLatest: tab.chatContinueLatest ?? false,
              chatDraftInjection: injection ?? tab.chatDraftInjection,
              orchestrationPacket: options.orchestrationPacket ?? tab.orchestrationPacket ?? null,
              supervisorStatus: options.supervisorStatus ?? tab.supervisorStatus ?? null,
              autoArchiveOnIdle: options.autoArchiveOnIdle ?? tab.autoArchiveOnIdle ?? false,
            }
          : tab
      ));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveTabId(resolvedTabId);
      persistTabsNow(nextTabs, resolvedTabId);
      return resolvedTabId;
    }

    const resolvedTabId = createWorkspaceTabId('chat');
    const now = Date.now();
    const newTab: TerminalTab = {
      id: resolvedTabId,
      label: options.label ?? options.orchestrationPacket?.title ?? adHocLaneTitle('chat'),
      kind: 'chat',
      tmuxSession: null,
      chatRuntime: resolvedRuntime,
      chatSessionKey: normalizedTargetSessionKey ?? undefined,
      chatModel: options.modelId ?? (resolvedRuntime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id),
      chatContinueLatest: false,
      chatDraftInjection: injection,
      chatCheckpoints: [],
      repo: options.repo,
      orchestrationPacket: options.orchestrationPacket ?? null,
      supervisorStatus: options.supervisorStatus ?? null,
      autoArchiveOnIdle: options.autoArchiveOnIdle ?? false,
      createdAt: now,
      lastActivity: now,
      chatMessages: [],
    };
    const nextTabs = [...currentTabs, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabId(resolvedTabId);
    persistTabsNow(nextTabs, resolvedTabId);
    return resolvedTabId;
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
    const currentTabs = tabsRef.current;
    const targetTabId = options.targetSessionKey?.startsWith('llm-chat:')
      ? options.targetSessionKey.slice('llm-chat:'.length)
      : null;
    const activeExisting = currentTabs.find((tab) => (
      tab.id === activeTabId
      && tab.kind === 'llm-chat'
      && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
    ));
    const targetedExisting = options.createNew || !targetTabId
      ? null
      : currentTabs.find((tab) => (
          tab.kind === 'llm-chat'
          && tab.id === targetTabId
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));
    const matchingExisting = options.createNew
      ? null
      : targetedExisting
        ?? activeExisting
        ?? currentTabs.find((tab) => (
          tab.kind === 'llm-chat'
          && (options.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));
    const injection = options.initialText ? {
      id: `workspace-llm-injection-${Date.now()}`,
      text: options.initialText,
      reason: options.draftReason,
      autoSend: options.autoSend,
    } : undefined;

    if (matchingExisting) {
      const resolvedTabId = matchingExisting.id;
      setTabs((previous) => previous.map((tab) => (
        tab.id === resolvedTabId ? { ...tab, label: options.label ?? tab.label, llmDraftInjection: injection ?? tab.llmDraftInjection } : tab
      )));
      setActiveTabId(resolvedTabId);
      return resolvedTabId;
    }

    const resolvedTabId = generateLlmChatTabId();
    const now = Date.now();
    setTabs((previous) => [...previous, {
      id: resolvedTabId,
      label: options.label ?? 'Chat',
      kind: 'llm-chat',
      tmuxSession: null,
      repo: options.repo,
      linkedIssue: null,
      llmDraftInjection: injection,
      createdAt: now,
      lastActivity: now,
    }]);
    setActiveTabId(resolvedTabId);
    return resolvedTabId;
  }, [activeTabId]);

  const openWorkspaceInspectorTab = useCallback((canvasTab: NonNullable<TerminalTab['canvasTab']>, options?: { repo?: RegisteredRepo; createNew?: boolean }) => {
    const backgroundLoad = canvasTab.kind === 'pr' || canvasTab.kind === 'issue';
    const currentTabs = tabsRef.current;
    const matchingExisting = options?.createNew
      ? null
      : currentTabs.find((tab) => (
          tab.kind === 'canvas'
          && tab.canvasTab?.id === canvasTab.id
          && (options?.repo ? tab.repo?.localPath === options.repo.localPath : true)
        ));

    if (matchingExisting) {
      const resolvedTabId = matchingExisting.id;
      setTabs((previous) => previous.map((tab) => (
        tab.id === resolvedTabId
          ? { ...tab, label: canvasTab.label, canvasTab, repo: options?.repo ?? tab.repo, lastActivity: Date.now() }
          : tab
      )));
      if (!backgroundLoad) {
        setActiveTabId(resolvedTabId);
      }
      return resolvedTabId;
    }

    const resolvedTabId = createWorkspaceTabId('canvas');
    const now = Date.now();
    setTabs((previous) => [...previous, {
      id: resolvedTabId,
      label: canvasTab.label,
      kind: 'canvas',
      tmuxSession: null,
      repo: options?.repo,
      canvasTab,
      unseen: backgroundLoad,
      createdAt: now,
      lastActivity: now,
    }]);
    if (!backgroundLoad) {
      setActiveTabId(resolvedTabId);
    }
    return resolvedTabId;
  }, []);

  const handleOpenWorkspaceCommitTab = useCallback((hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => {
    const nextMeta: Record<string, string> = { ...(meta ?? {}) };
    if (!nextMeta.workspace && repo?.localPath) {
      nextMeta.workspace = repo.localPath;
    }
    const repoSlug = repoSlugFromRemote(repo?.remoteUrl);
    if (!nextMeta.repo && repoSlug) {
      nextMeta.repo = repoSlug;
    }
    openWorkspaceInspectorTab({
      id: `commit:${hash}:${nextMeta.workspace ?? 'default'}`,
      kind: 'commit',
      label: hash.slice(0, 7),
      resourceId: hash,
      meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
    }, { repo });
  }, [openWorkspaceInspectorTab]);

  useImperativeHandle(ref, () => ({
    writeToTerminal: (sessionName, data) => {
      panelRefs.current.get(sessionName)?.writeData(data);
      const now = Date.now();
      setTabs((previous) => previous.map((tab) => (
        tab.tmuxSession === sessionName ? { ...tab, lastActivity: now } : tab
      )));
      if (urlDetectionEnabledRef.current) {
        try {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
          const clean = new TextDecoder().decode(bytes).replace(ANSI_RE, '');
          LOCALHOST_RE.lastIndex = 0;
          for (const match of clean.matchAll(LOCALHOST_RE)) {
            const port = parseInt(match[1], 10);
            if (IGNORED_PORTS.has(port) || detectedPortsRef.current.has(port)) continue;
            detectedPortsRef.current.add(port);
            const tab = tabsRef.current.find((entry) => entry.tmuxSession === sessionName);
            let url = match[0].replace('0.0.0.0', 'localhost');
            if (!url.startsWith('http')) url = `http://${url}`;
            const nextPreview: LocalhostPreview = {
              id: `preview-${port}`,
              tabId: tab?.id ?? '',
              url,
              port,
              detectedAt: now,
            };
            onPreviewDetected?.(nextPreview);
            setPreviews((previous) => previous.some((preview) => preview.port === port) ? previous : [...previous, nextPreview]);
          }
        } catch {
          return;
        }
      }
    },
    writeRaw: (sessionName, data) => {
      panelRefs.current.get(sessionName)?.writeRaw(data);
    },
    showImage: (sessionName, imageB64, filename) => {
      panelRefs.current.get(sessionName)?.showImage(imageB64, filename);
    },
    setTermError: (sessionName, error) => {
      panelRefs.current.get(sessionName)?.setError(error);
    },
    setTermExited: (sessionName) => {
      panelRefs.current.get(sessionName)?.setExited();
    },
    onSessionCreated: handleSessionCreated,
    clearDetectedPreview: (port) => {
      detectedPortsRef.current.delete(port);
      setPreviews((previous) => previous.filter((preview) => preview.port !== port));
    },
    isRestoreSettled: () => restoreSettledRef.current,
    openCliChatSession: (options) => openWorkspaceCliChatSession(options),
    injectIntoCliChat: (text, options) => (
      options?.targetSessionKey?.startsWith('llm-chat:')
        ? openWorkspaceLlmChatSession({
            repo: options?.repo,
            initialText: text,
            autoSend: options?.autoSend ?? false,
            createNew: options?.createNew ?? false,
            label: options?.label,
            draftReason: options?.draftReason,
            targetSessionKey: options?.targetSessionKey,
          })
        : openWorkspaceCliChatSession({
            runtime: options?.runtime,
            repo: options?.repo,
            modelId: options?.modelId,
            initialText: text,
            autoSend: options?.autoSend ?? false,
            createNew: options?.createNew ?? false,
            label: options?.label,
            draftReason: options?.draftReason,
            targetSessionKey: options?.targetSessionKey,
            orchestrationPacket: options?.orchestrationPacket,
            supervisorStatus: options?.supervisorStatus,
            autoArchiveOnIdle: options?.autoArchiveOnIdle,
          })
    ),
    focusTab: (tabId) => {
      const exists = tabsRef.current.some((tab) => tab.id === tabId);
      if (!exists) return false;
      setActiveTabId(tabId);
      persistTabsNow(tabsRef.current, tabId);
      return true;
    },
    setOrchestrationPacket: (tabId, packet) => {
      let found = false;
      setTabs((previous) => previous.map((tab) => {
        if (tab.id !== tabId) return tab;
        found = true;
        if (sameOrchestrationPacketBadge(tab.orchestrationPacket, packet) && (!packet || tab.autoArchiveOnIdle)) {
          return tab;
        }
        return {
          ...tab,
          orchestrationPacket: packet,
          lastActivity: packet?.status !== tab.orchestrationPacket?.status ? Date.now() : tab.lastActivity,
        };
      }));
      return found;
    },
    updateChatRuntimeStatus: (sessionKey, status, label) => {
      const normalizedTarget = sessionKey.trim();
      let found = false;
      setTabs((previous) => previous.map((tab) => {
        if (tab.kind !== 'chat') return tab;
        const currentSessionKey = normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey);
        if (!currentSessionKey || currentSessionKey !== normalizedTarget) return tab;
        found = true;
        const nextStatus = status.trim();
        const statusChanged = (tab.supervisorStatus ?? '') !== nextStatus;
        const nextPacketStatus = packetStatusFromSupervisorStatus(nextStatus, tab.orchestrationPacket?.status ?? null);
        const packetChanged = nextPacketStatus !== (tab.orchestrationPacket?.status ?? null);
        return {
          ...tab,
          label: label ?? tab.label,
          supervisorStatus: nextStatus,
          autoArchiveOnIdle: tab.autoArchiveOnIdle ?? true,
          orchestrationPacket: tab.orchestrationPacket
            ? { ...tab.orchestrationPacket, status: nextPacketStatus ?? tab.orchestrationPacket.status }
            : tab.orchestrationPacket,
          lastActivity: statusChanged || packetChanged ? Date.now() : tab.lastActivity,
        };
      }));
      return found;
    },
    getChatTabSnapshots: () => (
      tabsRef.current
        .filter(isAgentRuntimeTab)
        .map((tab) => ({
          tileId: stateScope,
          tabId: tab.id,
          label: tab.label,
          runtime: tab.chatRuntime,
          sessionKey: normalizeWorkspaceChatSessionKey(tab.chatRuntime, tab.chatSessionKey),
          repoPath: tab.repo?.localPath ?? preferredRepo?.localPath ?? null,
          branch: tab.repo?.branch ?? preferredRepo?.branch ?? null,
          status: resolveWorkspaceChatLaneStatus(tab) === 'running' ? 'running' : 'idle',
          lastActivityAt: new Date(tab.lastActivity).toISOString(),
          packetId: tab.orchestrationPacket?.packetId ?? null,
        }))
    ),
    openWorkspaceDiff: () => {
      const activeWorkspaceTab = tabsRef.current.find((tab) => tab.id === activeTabId);
      const repo = activeWorkspaceTab?.repo ?? tabsRef.current.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
      onOpenRepoDiff?.(repo);
    },
    openInspectorTab: (canvasTab, options) => openWorkspaceInspectorTab(canvasTab, options),
  }), [activeTabId, handleSessionCreated, onOpenRepoDiff, onPreviewDetected, openWorkspaceCliChatSession, openWorkspaceInspectorTab, openWorkspaceLlmChatSession, persistTabsNow, preferredRepo, stateScope]);

  const handleRegisterRepo = useCallback((localPath: string) => {
    fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', localPath }),
    }).catch(() => undefined);
  }, []);

  const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
    const agent = CLI_AGENTS.find((candidate) => candidate.id === agentId);
    if (!agent) return;
    const tabId = createWorkspaceTabId('terminal');
    const now = Date.now();
    const newTab: TerminalTab = {
      id: tabId,
      label: agent.label,
      kind: 'terminal',
      tmuxSession: null,
      cliAgent: agentId,
      repo,
      createdAt: now,
      lastActivity: now,
    };
    if (agent.command || repo) {
      const parts: string[] = [];
      if (repo) parts.push(`cd ${repo.localPath}`);
      if (agent.command) parts.push(agent.command);
      pendingCliCommands.current.set(tabId, parts.join(' && '));
    }
    setTabs((previous) => [...previous, newTab]);
    setActiveTabId(tabId);
    requestTerminalForTab(tabId, pendingCliCommands.current.get(tabId));
  }, [requestTerminalForTab]);

  const handleNewChatTab = useCallback((runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => {
    const tabId = createWorkspaceTabId('chat');
    const now = Date.now();
    setTabs((previous) => [...previous, {
      id: tabId,
      label: adHocLaneTitle('chat'),
      kind: 'chat',
      tmuxSession: null,
      chatRuntime: runtime,
      chatContinueLatest: false,
      chatModel: runtime === 'claude-code' ? CLAUDE_CLI_MODELS[0].id : CODEX_CLI_MODELS[0].id,
      repo,
      linkedIssue: null,
      createdAt: now,
      lastActivity: now,
      chatMessages: [],
      chatCheckpoints: [],
    }]);
    setActiveTabId(tabId);
  }, []);

  const handleNewLLMChatTab = useCallback((repo?: RegisteredRepo) => {
    const tabId = generateLlmChatTabId();
    const now = Date.now();
    setTabs((previous) => {
      const nextTabs = [...previous, {
        id: tabId,
        label: adHocLaneTitle('llm-chat'),
        kind: 'llm-chat',
        tmuxSession: null,
        repo: repo ?? preferredRepo ?? undefined,
        linkedIssue: null,
        createdAt: now,
        lastActivity: now,
      } as TerminalTab];
      persistTabsNow(nextTabs, tabId);
      return nextTabs;
    });
    setActiveTabId(tabId);
  }, [persistTabsNow, preferredRepo]);

  const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== tabId) return tab;
      const previousMessages = tab.chatMessages ?? [];
      if (sameTranscriptMessages(previousMessages, messages)) {
        return previousMessages === messages ? tab : { ...tab, chatMessages: messages };
      }
      const latestTimestamp = messages.reduce((max, entry) => Math.max(max, entry.timestamp ?? 0), 0);
      return {
        ...tab,
        chatMessages: messages,
        supervisorStatus: tab.supervisorStatus === 'launched' ? 'running' : tab.supervisorStatus,
        lastActivity: latestTimestamp > 0 ? latestTimestamp : Date.now(),
      };
    }));
  }, []);

  const handleUpdateLlmSummary = useCallback((tabId: string, summary: string | null) => {
    setTabs((previous) => {
      let changed = false;
      const next = previous.map((tab) => {
        if (tab.id !== tabId || tab.llmSummary === summary) return tab;
        changed = true;
        return { ...tab, llmSummary: summary };
      });
      return changed ? next : previous;
    });
  }, []);

  const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId
        ? {
            ...tab,
            chatSessionKey: tab.chatRuntime
              ? (normalizeWorkspaceChatSessionKey(tab.chatRuntime, sessionKey) ?? sessionKey)
              : sessionKey,
          }
        : tab
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
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== tabId || tab.kind !== 'chat') return tab;
      const messages = (tab.chatMessages ?? []).filter((entry) => !entry.id.startsWith('stream:'));
      if (messages.length === 0) return tab;
      const checkpoint: PersistedChatCheckpoint = {
        id: `checkpoint-${Date.now()}`,
        label: buildCheckpointLabel(tab, messages),
        createdAt: Date.now(),
        sourceMessageId: messages[messages.length - 1]?.id,
        messages: messages.map((entry) => ({ ...entry })),
      };
      return {
        ...tab,
        chatCheckpoints: [checkpoint, ...(tab.chatCheckpoints ?? [])].slice(0, 5),
      };
    }));
  }, []);

  const handleRestoreLatestCheckpoint = useCallback((tabId: string) => {
    let nextActiveId = '';
    setTabs((previous) => {
      const sourceTab = previous.find((tab) => tab.id === tabId && tab.kind === 'chat');
      const checkpoint = sourceTab?.chatCheckpoints?.[0];
      if (!sourceTab || !checkpoint) return previous;
      const nextTabId = createWorkspaceTabId('chat');
      nextActiveId = nextTabId;
      const now = Date.now();
      const recoveryNote = [
        `Resume from checkpoint "${checkpoint.label}".`,
        'Use this saved transcript point as the last known safe state.',
        'Re-establish the plan from the preserved context before making new edits.',
      ].join('\n\n');
      return [...previous, {
        id: nextTabId,
        label: `${sourceTab.label} · checkpoint`,
        kind: 'chat',
        tmuxSession: null,
        chatRuntime: sourceTab.chatRuntime,
        chatSessionKey: undefined,
        chatModel: sourceTab.chatModel,
        chatContinueLatest: false,
        chatDraftInjection: {
          id: `workspace-chat-injection-${Date.now()}`,
          text: recoveryNote,
          reason: 'checkpoint-restore',
          autoSend: false,
        },
        chatCheckpoints: sourceTab.chatCheckpoints,
        repo: sourceTab.repo,
        linkedIssue: sourceTab.linkedIssue ?? null,
        createdAt: now,
        lastActivity: now,
        chatMessages: checkpoint.messages.map((entry) => ({ ...entry })),
      }];
    });
    if (nextActiveId) {
      setActiveTabId(nextActiveId);
    }
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
    const shellTab = tabs.find((tab) => tab.kind === 'terminal' && tab.tmuxSession);
    if (shellTab?.tmuxSession) {
      sendTerminalInput(shellTab.tmuxSession, command + '\n');
      return;
    }
    const pendingShell = tabs.find((tab) => tab.kind === 'terminal' && !tab.tmuxSession);
    if (pendingShell) {
      pendingCliCommands.current.set(pendingShell.id, command);
      setActiveTabId(pendingShell.id);
      return;
    }
    const nextTabId = createWorkspaceTabId('terminal');
    const now = Date.now();
    setTabs((previous) => [...previous, {
      id: nextTabId,
      label: 'Terminal',
      kind: 'terminal',
      tmuxSession: null,
      cliAgent: 'shell',
      createdAt: now,
      lastActivity: now,
    }]);
    setActiveTabId(nextTabId);
    requestTerminalForTab(nextTabId, command);
  }, [requestTerminalForTab, sendTerminalInput, tabs]);

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === tabId);
      if (index < 0) return previous;
      const tab = previous[index];
      if (tab.tmuxSession) {
        sendTerminalDetach(tab.tmuxSession);
        panelRefs.current.delete(tab.tmuxSession);
      }
      pendingCliCommands.current.delete(tabId);
      for (const [requestId, pendingTabId] of pendingRequestRef.current) {
        if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
      }
      const remaining = previous.filter((entry) => entry.id !== tabId);
      if (tabId === activeTabId && remaining.length > 0) {
        setActiveTabId(remaining[Math.min(index, remaining.length - 1)].id);
      } else if (tabId === activeTabId) {
        setActiveTabId('');
      }
      setPreviews((previousPreviews) => {
        const toRemove = previousPreviews.filter((preview) => preview.tabId === tabId);
        toRemove.forEach((preview) => detectedPortsRef.current.delete(preview.port));
        return previousPreviews.filter((preview) => preview.tabId !== tabId);
      });
      return remaining;
    });
  }, [activeTabId, sendTerminalDetach]);

  const archiveWorkspaceTab = useCallback((tabId: string, packetId?: string | null) => {
    handleCloseTab(tabId);
    if (!packetId) return;
    const missionState = readOrchestratorMissionState();
    const packet = missionState.packets.find((entry) => entry.id === packetId);
    if (!packet || packet.archivedAt) return;
    void persistOrchestratorMissionState({
      ...missionState,
      packets: missionState.packets.map((entry) => (
        entry.id === packetId ? { ...entry, archivedAt: new Date().toISOString() } : entry
      )),
    });
  }, [handleCloseTab]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.kind !== 'chat' || !tab.autoArchiveOnIdle) continue;
      if (tab.id === effectiveActiveTabId) continue;
      const laneStatus = resolveWorkspaceChatLaneStatus(tab);
      const eligible = laneStatus === 'awaiting_review'
        || laneStatus === 'idle'
        || laneStatus === 'released'
        || tab.supervisorStatus?.trim().toLowerCase() === 'completed'
        || tab.supervisorStatus?.trim().toLowerCase() === 'failed';
      if (!eligible) continue;
      const idleForMs = Math.max(0, now - tab.lastActivity);
      const delayMs = Math.max(0, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS - idleForMs);
      const timerId = window.setTimeout(() => {
        archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
      }, delayMs);
      timers.set(tab.id, timerId);
    }
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
    };
  }, [archiveWorkspaceTab, effectiveActiveTabId, tabs]);

  useEffect(() => {
    for (const tab of tabs) {
      if (tab.tmuxSession && pendingCliCommands.current.has(tab.id)) {
        const command = pendingCliCommands.current.get(tab.id)!;
        pendingCliCommands.current.delete(tab.id);
        fetch('/api/panel/terminal-exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionName: tab.tmuxSession, command }),
        }).catch(() => {
          setTimeout(() => {
            sendTerminalInput(tab.tmuxSession!, command + '\n');
          }, 2000);
        });
      }
    }
  }, [sendTerminalInput, tabs]);

  const handleDragStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      if (!containerDivRef.current) return;
      const rect = containerDivRef.current.getBoundingClientRect();
      const ratio = (moveEvent.clientY - rect.top) / rect.height;
      setPreviewHeight(Math.min(0.8, Math.max(0.2, ratio)));
    };
    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    onActiveLaneChange?.(activeLaneState);
  }, [activeLaneState, onActiveLaneChange]);

  useEffect(() => {
    if (!containerDivRef.current) return undefined;
    const root = containerDivRef.current;
    const syncHelperNames = () => {
      const helperTextareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea'));
      helperTextareas.forEach((textarea, index) => {
        if (!textarea.getAttribute('name')) {
          textarea.setAttribute('name', `workspaceTerminalInput-${stateScope}-${index}`);
        }
      });
    };
    syncHelperNames();
    const observer = new MutationObserver(() => {
      syncHelperNames();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
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
    const now = Date.now();
    const newTab: TerminalTab = {
      id: historyTabId,
      label: title.slice(0, 20) + (title.length > 20 ? '...' : ''),
      kind: 'llm-chat',
      tmuxSession: null,
      repo: historyRepo?.localPath || historyRepo?.name
        ? {
            name: historyRepo?.name ?? currentTab.repo?.name ?? 'repo',
            localPath: historyRepo?.localPath ?? currentTab.repo?.localPath ?? '',
            branch: historyRepo?.branch ?? currentTab.repo?.branch ?? null,
            remoteUrl: historyRepo?.remoteUrl ?? currentTab.repo?.remoteUrl,
          }
        : currentTab.repo,
      linkedIssue: currentTab.linkedIssue ?? null,
      createdAt: now,
      lastActivity: now,
    };
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
