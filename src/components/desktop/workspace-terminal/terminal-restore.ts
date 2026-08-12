import {
  buildRepoStateScope,
  checkAliveSessions,
  formatPersistedRuntimeSessionKey,
  loadLiveRuntimeSessionKeys,
  loadTabState,
  sanitizePersistedTabState,
  stripPersistedRuntimeSessionKey,
  type PersistedRuntimeSessionKey,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type {
  RegisteredRepo,
  TerminalTab,
} from '@/components/desktop/workspace-terminal/types';
import {
  isOwnedOrchestratorSessionKey,
  runtimeFromOwnedSessionKey,
} from '@/lib/orchestrator/runtime-capabilities';
import { nextTerminalLabel } from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
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

export type RestoreValidationMode = 'optimistic' | 'validated';

function unwrapRuntimeSessionKey(rawSessionKey: string): string {
  for (const stalePrefix of ['codex:', 'claude-code:']) {
    if (!rawSessionKey.startsWith(stalePrefix)) continue;
    const inner = rawSessionKey.slice(stalePrefix.length);
    if (
      isOwnedOrchestratorSessionKey(inner)
      || inner.startsWith('codex-discovered:')
      || inner.startsWith('codex-live:')
    ) {
      return inner;
    }
  }
  return rawSessionKey;
}

function isOwnedSessionKey(sessionKey: string): boolean {
  return isOwnedOrchestratorSessionKey(sessionKey);
}

/**
 * The `thoughts-*` ids the operator has archived. Bounded + fail-open: a slow
 * or failed fetch returns `null`, which disables the archived-tab filter so we
 * NEVER drop an orchestrator tab we can't positively confirm is archived.
 */
async function fetchArchivedOrchestratorThreadIds(): Promise<Set<string> | null> {
  try {
    const result = await Promise.race([
      fetch('/api/mobile/orchestrator/threads?archived=1', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null)),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    const archivedIds = (result as { archivedIds?: unknown } | null)?.archivedIds;
    if (!Array.isArray(archivedIds)) return null;
    return new Set(archivedIds.filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

/**
 * Packet ids of lanes still in the ACTIVE lane registry. Same bounded +
 * fail-open doctrine as the archived-thread fetch: a slow or failed probe
 * returns `null`, which disables the stale-lane filter — we never drop a
 * packet-bound tab we can't positively confirm is dead.
 */
async function fetchActiveLanePacketIds(): Promise<Set<string> | null> {
  try {
    const result = await Promise.race([
      fetch('/api/lanes?active=true', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null)),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    const lanes = (result as { lanes?: unknown } | null)?.lanes;
    if (!Array.isArray(lanes)) return null;
    const ids = lanes
      .map((lane) => (lane && typeof lane === 'object' ? (lane as { packetId?: unknown }).packetId : null))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  } catch {
    return null;
  }
}

/**
 * Active/archive state for persisted owned-runtime sessions. Bounded and
 * fail-open like the other restore probes: only a successful positive state
 * may remove a tab, while timeout, transport, and malformed responses return
 * `null` and preserve the historical restore behavior.
 */
async function fetchOwnedSessionStates(sessionKeys: string[]): Promise<Record<string, string> | null> {
  try {
    const query = encodeURIComponent(sessionKeys.join(','));
    const result = await Promise.race([
      fetch(`/api/runtime/archive?sessionKeys=${query}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null)),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);
    const states = (result as { states?: unknown } | null)?.states;
    if (!states || typeof states !== 'object' || Array.isArray(states)) return null;
    const entries = Object.entries(states);
    if (entries.some(([, state]) => typeof state !== 'string')) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return null;
  }
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
  rawSaved: PersistedTabState,
  options: ApplyPersistedStateOptions,
  cancelled?: () => boolean,
  validationMode: RestoreValidationMode = 'validated',
): Promise<ApplyPersistedStateResult | null> {
  // #717 — third defensive strip on the in-memory boundary between API/cache
  // and the restore pipeline. `loadTabState` already runs the strip, but a
  // caller who hands us a `PersistedTabState` from any other source must still
  // produce zombie-free output.
  const saved = sanitizePersistedTabState(rawSaved);
  const tmuxNames = saved.tabs.map((tab) => tab.tmuxSession).filter(Boolean) as string[];
  const needsLivenessCheck = saved.tabs.some((tab) => {
    const kind = tab.kind ?? 'terminal';
    if (kind === 'terminal') return true;
    if (kind === 'chat' && !tab.orchestrationPacket) return true;
    return false;
  });

  // Kick the archived-thread fetch off in parallel with the liveness check so
  // the two bounded probes overlap rather than serialize. Gated on actually
  // having an orchestrator-shaped tab — a pure-terminal workspace skips it.
  const needsArchivedCheck = saved.tabs.some((tab) => {
    const kind = tab.kind ?? 'terminal';
    const id = tab.id ?? '';
    return kind === 'orchestrator' || id.startsWith('orchestrator-') || id.startsWith('thoughts-');
  });
  const archivedThreadIdsPromise = validationMode === 'validated' && needsArchivedCheck
    ? fetchArchivedOrchestratorThreadIds()
    : Promise.resolve<Set<string> | null>(null);

  // Stale-lane sweep (2026-07-12): packet-bound chat tabs whose lane left the
  // active registry (archived/pruned) restore as zombie pills in the tab
  // strip forever — nothing else cleans them. Probe runs in parallel, gated
  // on actually having a packet-bound tab.
  const needsLaneCheck = saved.tabs.some((tab) => (
    (tab.kind ?? 'terminal') === 'chat' && Boolean(tab.orchestrationPacket?.packetId)
  ));
  const activeLanePacketIdsPromise = validationMode === 'validated' && needsLaneCheck
    ? fetchActiveLanePacketIds()
    : Promise.resolve<Set<string> | null>(null);

  const ownedSessionKeys = Array.from(new Set(saved.tabs.flatMap((tab) => {
    if ((tab.kind ?? 'terminal') !== 'chat' || tab.orchestrationPacket) return [];
    const effectiveSessionKey = unwrapRuntimeSessionKey(tab.chatSessionKey?.trim() ?? '');
    return isOwnedSessionKey(effectiveSessionKey) ? [effectiveSessionKey] : [];
  }))).slice(0, 100);
  const ownedSessionStatesPromise = validationMode === 'validated' && ownedSessionKeys.length > 0
    ? fetchOwnedSessionStates(ownedSessionKeys)
    : Promise.resolve<Record<string, string> | null>(null);

  let alive: Set<string>;
  let liveRuntimeSessionKeys: Set<PersistedRuntimeSessionKey>;

  if (validationMode === 'validated' && needsLivenessCheck) {
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

  const archivedOrchestratorThreadIds = await archivedThreadIdsPromise;
  if (cancelled?.()) return null;
  const activeLanePacketIds = await activeLanePacketIdsPromise;
  if (cancelled?.()) return null;
  const ownedSessionStates = await ownedSessionStatesPromise;
  if (cancelled?.()) return null;

  const currentPreferredRepo = options.preferredRepo;
  const restoredTabs: TerminalTab[] = [];
  const sessionsToAttach: string[] = [];
  const seenRuntimeChats = new Set<string>();
  const seenTerminalSessions = new Set<string>();
  const seenOrchestratorThreads = new Set<string>();
  const seenTabIds = new Set<string>();
  let restoredActiveTabId: string | null = null;

  for (const savedTab of saved.tabs) {
    if (cancelled?.()) return null;
    const now = Date.now();
    const tabKind = savedTab.kind ?? 'terminal';

    // Orchestrator tabs restore ONLY when they carry a recoverable chat-history
    // thread — either the thread id IS the tab id (history-opened tabs use a
    // `thoughts-…` id) or a separate `orchestratorThreadId` was persisted for a
    // spawned tab. This reopens each orchestrator conversation on its own tab
    // instead of collapsing every tab onto the global last-active thread.
    //
    // Tabs with NO recoverable thread are dropped here (the migration effect in
    // useWorkspaceTerminalController injects a single fresh Orchestrator). That
    // preserves the original #708 / #714 guarantees: a stale/empty orchestrator
    // entry — or a #714 zombie whose `kind` was mutated to `terminal` but whose
    // `orchestrator-` id remains — has no thread id, so it can never resurrect
    // as a duplicate tab or leak the "Orchestrator" label onto a terminal.
    if (tabKind === 'orchestrator' || (savedTab.id ?? '').startsWith('orchestrator-')) {
      const recoveredThreadId = (savedTab.id ?? '').startsWith('thoughts-')
        ? savedTab.id
        : (savedTab.orchestratorThreadId ?? null);
      if (!recoveredThreadId) continue;
      // Archived threads are off the active surfaces — their persisted tab must
      // not resurrect on reload. Only drop ids positively confirmed archived; a
      // null set (fetch failed/disabled) leaves every tab intact.
      if (archivedOrchestratorThreadIds?.has(recoveredThreadId)) continue;
      // One orchestrator tab per thread — a second persisted tab pointing at the
      // same conversation is a duplicate; drop it so reload can't resurrect the
      // two-copies-of-one-thread bug.
      if (seenOrchestratorThreads.has(recoveredThreadId)) continue;
      seenOrchestratorThreads.add(recoveredThreadId);
      const tabId = claimWorkspaceTabId('orchestrator', seenTabIds, savedTab.id);
      restoredTabs.push({
        id: tabId,
        label: savedTab.label,
        kind: 'orchestrator',
        tmuxSession: null,
        repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
        mode: savedTab.mode ?? 'fleet',
        singleRuntime: savedTab.singleRuntime,
        chatModelId: savedTab.chatModelId,
        chatOpenrouterModel: savedTab.chatOpenrouterModel,
        orchestratorThreadId: recoveredThreadId,
        outsideWorkerHost: savedTab.outsideWorkerHost,
        createdAt: now,
        lastActivity: now,
      });
      if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
      continue;
    }

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

    if (tabKind === 'fleet-canvas') {
      // Pure view over useOrchestratorData — nothing live to recover, so the
      // tab restores unconditionally (card positions live in localStorage via
      // fleet-canvas-store keyed by repo scope, not on the tab record).
      const tabId = claimWorkspaceTabId('fleet-canvas', seenTabIds, savedTab.id);
      restoredTabs.push({
        id: tabId,
        label: savedTab.label || 'Canvas',
        kind: 'fleet-canvas',
        tmuxSession: null,
        repo: savedTab.repoPath ? { name: savedTab.repoName ?? 'repo', localPath: savedTab.repoPath } : (currentPreferredRepo ?? undefined),
        createdAt: now,
        lastActivity: now,
      });
      if (savedTab.id === saved.activeTabId) restoredActiveTabId = tabId;
      continue;
    }

    if (tabKind === 'chat') {
      // Stale-lane sweep: only a POSITIVE "lane not active" verdict drops a
      // packet-bound tab (fail-open on null probe).
      const badgePacketId = savedTab.orchestrationPacket?.packetId?.trim();
      if (badgePacketId && activeLanePacketIds && !activeLanePacketIds.has(badgePacketId)) continue;
      // Reclassify runtime from sessionKey prefix if persisted value is stale.
      // Tabs saved pre-v0.1.24 persisted chatRuntime='codex' even for dispatched
      // Gemini/opencode packets, and `formatPersistedRuntimeSessionKey` then
      // prepended `codex:` in front of the real owned prefix — ending up with
      // triple-wrapped keys like `codex:gemini-owned:gemini-owned-<id>`.
      // Unwrap the leading codex:/claude-code: if an inner owned prefix is
      // visible, then reclassify based on the unwrapped key.
      const rawSessionKey = savedTab.chatSessionKey?.trim() ?? '';
      const rawClaudeSessionId = savedTab.claudeSessionId?.trim() ?? '';
      const unwrappedSessionKey = unwrapRuntimeSessionKey(rawSessionKey);
      let effectiveRuntime = savedTab.chatRuntime;
      let effectiveModel = savedTab.chatModel;
      const effectiveSessionKey = unwrappedSessionKey;
      const ownedRuntime = runtimeFromOwnedSessionKey(unwrappedSessionKey);
      if (ownedRuntime && effectiveRuntime !== ownedRuntime) {
        effectiveRuntime = ownedRuntime;
      }
      if (ownedRuntime === 'gemini') {
        effectiveModel = 'gemini-3.1-pro-preview';
      } else if (ownedRuntime === 'opencode') {
        effectiveModel = 'opencode/deepseek-v4-flash-free';
      } else if (ownedRuntime === 'cursor') {
        effectiveModel = 'cli:cursor:default';
      } else if (ownedRuntime === 'grok') {
        effectiveModel = 'cli:grok:default';
      } else if (!ownedRuntime && (
        (unwrappedSessionKey.startsWith('codex-owned:')
          || unwrappedSessionKey.startsWith('codex:')
          || unwrappedSessionKey.startsWith('codex-discovered:')
          || unwrappedSessionKey.startsWith('codex-live:'))
        && effectiveRuntime !== 'codex'
      )) {
        effectiveRuntime = 'codex';
      } else if (unwrappedSessionKey.startsWith('claude-code:') && effectiveRuntime !== 'claude-code') {
        effectiveRuntime = 'claude-code';
      }
      const ownedSessionState = ownedSessionStates?.[effectiveSessionKey];
      if (!badgePacketId && (ownedSessionState === 'archived' || ownedSessionState === 'missing')) continue;
      // Persist the unwrapped key so downstream endpoints route correctly.
      const savedChatSessionKey = effectiveSessionKey
        || savedTab.chatSessionKey
        || (effectiveRuntime === 'claude-code' ? rawClaudeSessionId : undefined);
      const prefixedSessionKey = formatPersistedRuntimeSessionKey(effectiveRuntime, savedChatSessionKey);
      if (prefixedSessionKey && seenRuntimeChats.has(`${prefixedSessionKey}:${savedTab.repoPath ?? ''}`)) {
        continue;
      }
      if (prefixedSessionKey) {
        seenRuntimeChats.add(`${prefixedSessionKey}:${savedTab.repoPath ?? ''}`);
      }
      const liveSessionKey = prefixedSessionKey && liveRuntimeSessionKeys.has(prefixedSessionKey)
        ? stripPersistedRuntimeSessionKey(effectiveRuntime, savedChatSessionKey)
        : isOwnedOrchestratorSessionKey(effectiveSessionKey)
          ? effectiveSessionKey
          : undefined;
      const restoredClaudeSessionId = effectiveRuntime === 'claude-code'
        ? (rawClaudeSessionId || stripPersistedRuntimeSessionKey(effectiveRuntime, savedChatSessionKey))
        : undefined;
      const shouldPreserveHistoricalSessionKey = isOwnedOrchestratorSessionKey(effectiveSessionKey)
        || effectiveSessionKey.startsWith('codex-discovered:')
        || effectiveSessionKey.startsWith('codex-live:');
      const restoredChatSessionKey = liveSessionKey
        ?? (shouldPreserveHistoricalSessionKey ? effectiveSessionKey : undefined);
      const tabId = claimWorkspaceTabId('chat', seenTabIds, savedTab.id);
      restoredTabs.push({
        id: tabId,
        label: savedTab.label,
        kind: 'chat',
        tmuxSession: null,
        chatRuntime: effectiveRuntime,
        chatSessionKey: restoredChatSessionKey,
        laneId: savedTab.laneId ?? null,
        claudeSessionId: restoredClaudeSessionId || undefined,
        chatModel: effectiveModel,
        chatContinueLatest: restoredChatSessionKey ? savedTab.chatContinueLatest : false,
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

  // Issue #708 — backfill terminal tabs whose label was lost or inherited
  // the literal string "Orchestrator" from an earlier persisted-orchestrator
  // fallthrough. We assign each one the next available `Terminal N` label so
  // the result never collides with an existing valid number.
  for (const restored of restoredTabs) {
    if (restored.kind !== 'terminal') continue;
    const trimmed = restored.label?.trim() ?? '';
    if (trimmed && trimmed !== 'Orchestrator') continue;
    restored.label = nextTerminalLabel(restoredTabs);
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
/*  mergeUserSpawnedTabs                                               */
/* ------------------------------------------------------------------ */

/**
 * A restore landing must never eat tabs the user created while it was in
 * flight (GQXEZD, 2026-07-16: "New session" clicked during a slow Rosetta
 * re-restore — applyPersistedState's wholesale setTabs(result.tabs) replaced
 * the array and silently dropped the just-spawned tab; no error anywhere).
 *
 * `preRestoreTabIds` is the id set captured BEFORE the async compute began;
 * anything in `currentTabs` that wasn't there at capture time and isn't in
 * the restored set is a user action that outranks the restore.
 */
export function mergeUserSpawnedTabs(
  restoredTabs: TerminalTab[],
  currentTabs: TerminalTab[],
  preRestoreTabIds: ReadonlySet<string>,
): TerminalTab[] {
  const restoredIds = new Set(restoredTabs.map((tab) => tab.id));
  const userAdded = currentTabs.filter((tab) => !preRestoreTabIds.has(tab.id) && !restoredIds.has(tab.id));
  return userAdded.length > 0 ? [...restoredTabs, ...userAdded] : restoredTabs;
}

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
  // Belt-and-suspenders (2026-06-22): a worker/CLI chat tab (kind:'chat') hosts
  // a live agent transcript and must never be wiped by a repo-scope flip — even
  // after its orchestrationPacket badge was dropped during session-discovery
  // reconstruction (the badge "doesn't survive" per WorkspaceChatPane). Without
  // this, a scope oscillation cleared the tab and the transcript vanished into
  // the empty picker.
  const hasChatSessionTabs = currentTabs.some((tab) => tab.kind === 'chat');
  if (hasChatSessionTabs) return true;
  // Same doctrine for the operator's OWN conversations (GQXEZD, 2026-07-16):
  // an orchestrator tab bound to a thread — or one the user JUST spawned
  // (freshSpawn) — must never be wiped by a repo-scope flip. On slow
  // (Rosetta) boots the repo registry hydrates AFTER the no-repo restore
  // landed; the key flip found an orchestrator-only tab set with no repo
  // stamped, failed every condition below, and setTabs([]) emptied the
  // workspace ("Start a new session" CTA) — then the async re-restore
  // clobbered anything spawned into the gap. A blank BOOT-default
  // orchestrator (no thread, not user-spawned) stays expendable so a real
  // repo switch can still load that repo's saved tabs.
  const hasLiveOrchestratorTabs = currentTabs.some((tab) => (
    tab.kind === 'orchestrator' && (Boolean(tab.orchestratorThreadId) || tab.freshSpawn === true)
  ));
  if (hasLiveOrchestratorTabs) return true;
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
  const currentStableRepoScope = !options.splitCreated && options.preferredRepoPath
    ? buildRepoStateScope(options.preferredRepoPath)
    : null;
  const [rootSaved, repoSaved] = await Promise.all([
    options.splitCreated ? Promise.resolve(null) : loadTabState(options.stateScope, null),
    currentStableRepoScope ? loadTabState(currentStableRepoScope, options.preferredRepoPath) : Promise.resolve(null),
  ]);
  if (cancelled()) return null;
  let saved = rootSaved;
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
    saved = repoSaved;
  }

  return saved && saved.tabs.length > 0 ? saved : null;
}
