import {
  buildRepoStateScope,
  checkAliveSessions,
  formatPersistedRuntimeSessionKey,
  loadLiveRuntimeSessionKeys,
  loadTabState,
  stripPersistedRuntimeSessionKey,
  type PersistedRuntimeSessionKey,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type {
  RegisteredRepo,
  TerminalTab,
} from '@/components/desktop/workspace-terminal/types';
import {
  claimWorkspaceTabId,
} from '@/components/desktop/workspace-terminal/utils';

export interface ApplyPersistedStateOptions {
  preferredRepo: RegisteredRepo | null;
  defaultTab: 'llm-chat' | 'terminal';
  createDefaultChatTab: () => TerminalTab;
}

export interface ApplyPersistedStateResult {
  tabs: TerminalTab[];
  activeTabId: string;
  sessionsToAttach: string[];
  deadTerminalTabs: TerminalTab[];
  restoredAny: boolean;
}

/**
 * Pure logic for restoring persisted tab state.
 * Computes which tabs to restore, which tmux sessions to reattach,
 * and which dead terminal tabs need new sessions.
 *
 * The caller applies the result to React state and performs side effects
 * (terminal attach/create).
 */
export async function computeRestoredTabs(
  saved: PersistedTabState,
  options: ApplyPersistedStateOptions,
  cancelled?: () => boolean,
): Promise<ApplyPersistedStateResult | null> {
  const tmuxNames = saved.tabs.map((tab) => tab.tmuxSession).filter(Boolean) as string[];
  const needsLivenessCheck = saved.tabs.some((tab) => {
    const kind = tab.kind ?? 'terminal';
    if (kind === 'terminal') return true;
    if (kind === 'chat' && !tab.orchestrationPacket) return true;
    return false;
  });

  let alive: Set<string>;
  let liveRuntimeSessionKeys: Set<PersistedRuntimeSessionKey>;

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
      .filter((key): key is PersistedRuntimeSessionKey => key !== null);
    liveRuntimeSessionKeys = new Set(optimisticKeys);
  }
  if (cancelled?.()) return null;

  const currentPreferredRepo = options.preferredRepo;
  const restoredTabs: TerminalTab[] = [];
  const sessionsToAttach: string[] = [];
  const seenRuntimeChats = new Set<string>();
  const seenTerminalSessions = new Set<string>();
  const seenTabIds = new Set<string>();
  let restoredActiveTabId: string | null = null;

  for (const savedTab of saved.tabs) {
    if (cancelled?.()) return null;
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

  let finalTabs: TerminalTab[];
  let nextActiveId: string;

  if (options.defaultTab === 'llm-chat') {
    const restoredChat = restoredTabs.find((tab) => tab.kind === 'llm-chat');
    if (restoredChat) {
      nextActiveId = effectiveRestoredActiveId ?? restoredChat.id;
      finalTabs = restoredTabs;
    } else if (restoredTabs.length > 0) {
      const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
      nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTabs[0]?.id ?? '';
      finalTabs = restoredTabs;
    } else {
      const defaultChat = options.createDefaultChatTab();
      finalTabs = [defaultChat, ...restoredTabs];
      nextActiveId = defaultChat.id;
    }
  } else {
    const restoredCliChat = restoredTabs.find((tab) => tab.kind === 'chat');
    const restoredTerminal = restoredTabs.find((tab) => tab.kind === 'terminal');
    nextActiveId = effectiveRestoredActiveId ?? restoredCliChat?.id ?? restoredTerminal?.id ?? restoredTabs[0]?.id ?? '';
    finalTabs = restoredTabs;
  }
  if (cancelled?.()) return null;

  const deadTerminalTabs = finalTabs.filter((tab) => tab.kind === 'terminal' && tab.tmuxSession === null);

  return {
    tabs: finalTabs,
    activeTabId: nextActiveId,
    sessionsToAttach,
    deadTerminalTabs,
    restoredAny: restoredTabs.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/*  loadInitialTabState                                                */
/* ------------------------------------------------------------------ */

export interface LoadInitialTabStateOptions {
  stateScope: string;
  defaultTab: 'llm-chat' | 'terminal';
  splitCreated: boolean;
  preferredRepoPath: string | null;
}

/**
 * Resolves the correct persisted tab state to restore at startup.
 * Returns `null` if no saved state found.
 */
/* ------------------------------------------------------------------ */
/*  canPreserveScopedTabs                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  shouldSkipRestoreKeyChange                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  resetControllerRefs                                                */
/* ------------------------------------------------------------------ */

export function resetControllerRefs(refs: {
  restoredRef: React.MutableRefObject<boolean>;
  restoreSettledRef: React.MutableRefObject<boolean>;
  previousWsConnectedRef: React.MutableRefObject<boolean>;
  initialTerminalBootstrapRef: React.MutableRefObject<boolean>;
  reportedRepoScopeRef: React.MutableRefObject<string | null | undefined>;
  reportedChatSessionsSignatureRef: React.MutableRefObject<string>;
  reportedActiveChatSessionKeyRef: React.MutableRefObject<string | null>;
  detectedPortsRef: React.MutableRefObject<Set<number>>;
  pendingCliCommands: React.MutableRefObject<Map<string, string>>;
  pendingRequestRef: React.MutableRefObject<Map<string, string>>;
  saveTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}): void {
  refs.restoredRef.current = false;
  refs.restoreSettledRef.current = false;
  refs.previousWsConnectedRef.current = false;
  refs.initialTerminalBootstrapRef.current = false;
  refs.reportedRepoScopeRef.current = undefined;
  refs.reportedChatSessionsSignatureRef.current = '';
  refs.reportedActiveChatSessionKeyRef.current = null;
  refs.detectedPortsRef.current.clear();
  refs.pendingCliCommands.current.clear();
  refs.pendingRequestRef.current.clear();
  if (refs.saveTimerRef.current) {
    clearTimeout(refs.saveTimerRef.current);
    refs.saveTimerRef.current = null;
  }
}

/* ------------------------------------------------------------------ */
/*  shouldSkipRestoreKeyChange                                         */
/* ------------------------------------------------------------------ */

export function shouldSkipRestoreKeyChange(
  previousKey: string | null,
  restoreKey: string,
  restoreInFlight: boolean,
  tabCount: number,
): boolean {
  if (previousKey === null) return true;
  const previousScope = previousKey.split('::')[0];
  const nextScope = restoreKey.split('::')[0];
  return restoreInFlight && previousScope === nextScope && tabCount === 0;
}

/* ------------------------------------------------------------------ */
/*  canPreserveScopedTabs                                              */
/* ------------------------------------------------------------------ */

export function canPreserveScopedTabs(
  currentTabs: TerminalTab[],
  nextPreferredRepoPath: string | null,
): boolean {
  if (currentTabs.length === 0) return false;
  const hasOrchestratedTabs = currentTabs.some((tab) => Boolean(tab.orchestrationPacket));
  if (hasOrchestratedTabs) return true;
  if (!nextPreferredRepoPath) return false;
  return (
    currentTabs.some((tab) => tab.repo?.localPath === nextPreferredRepoPath)
    && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === nextPreferredRepoPath)
  );
}

/* ------------------------------------------------------------------ */
/*  loadInitialTabState                                                */
/* ------------------------------------------------------------------ */

export async function loadInitialTabState(
  options: LoadInitialTabStateOptions,
  cancelled: () => boolean,
): Promise<PersistedTabState | null> {
  let saved = options.splitCreated ? null : await loadTabState(options.stateScope, null);
  if (cancelled()) return null;

  const currentStableRepoScope = !options.splitCreated && options.preferredRepoPath
    ? buildRepoStateScope(options.preferredRepoPath)
    : null;
  const savedRepoPaths = saved
    ? Array.from(new Set(saved.tabs.map((tab) => tab.repoPath).filter((value): value is string => Boolean(value))))
    : [];
  const savedHasOrchestratedTabs = Boolean(saved?.tabs.some((tab) => tab.orchestrationPacket));
  const savedMatchesPreferredRepo = !options.preferredRepoPath
    || savedRepoPaths.length === 0
    || savedRepoPaths.includes(options.preferredRepoPath);

  if (
    !options.splitCreated
    && (!saved || saved.tabs.length === 0 || (!savedMatchesPreferredRepo && !savedHasOrchestratedTabs))
    && currentStableRepoScope
  ) {
    saved = await loadTabState(currentStableRepoScope, options.preferredRepoPath);
    if (cancelled()) return null;
  }

  return saved && saved.tabs.length > 0 ? saved : null;
}
