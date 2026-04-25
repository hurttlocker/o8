/**
 * Persisted terminal tab state — survives app restarts.
 * Stored per workspace tile under ~/.o8/terminal-states/<scope>.json
 */

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { WorkspaceOrchestrationPacketBadge } from '@/lib/orchestrator/types';

export interface PersistedChatCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  sourceMessageId?: string;
  messages: MobileTranscriptEntry[];
}

export interface PersistedTab {
  id: string;
  label: string;
  kind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator'; // defaults to 'terminal' for backward compat
  cliAgent: string; // 'shell' | 'claude' | 'codex' | etc
  repoName?: string;
  repoPath?: string;
  tmuxSession?: string; // last known tmux session name (may still be alive)
  chatRuntime?: 'codex' | 'claude-code' | 'gemini' | 'opencode'; // for kind='chat' (CLI Session)
  chatSessionKey?: string; // for kind='chat' (CLI Session)
  chatModel?: string;
  chatContinueLatest?: boolean;
  chatCheckpoints?: PersistedChatCheckpoint[];
  linkedIssue?: {
    repo: string;
    number: number;
    title: string;
    body?: string | null;
    url?: string;
  };
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
  canvasTab?: {
    id: string;
    kind: string;
    label: string;
    resourceId: string;
    meta?: Record<string, string>;
  };
}

export interface PersistedTabState {
  version: 1;
  activeTabId: string;
  tabs: PersistedTab[];
  savedAt: string; // ISO timestamp
}

export type PersistedRuntimeSessionKey =
  | `codex:${string}`
  | `codex-owned:${string}`
  | `codex-discovered:${string}`
  | `codex-live:${string}`
  | `claude-code:${string}`
  | `gemini-owned:${string}`
  | `opencode-owned:${string}`;

const API_PATH = '/api/panel/terminal-state';

/**
 * Hard cap on persisted tabs per scope. Dogfood-week users accumulate dozens of
 * stale chat tabs (the user hit 84 in `repo-1j19dlc.json`); fresh installs are
 * fine. The cap is enforced both on save (preventatively) and on load
 * (defensively, for files already on disk).
 */
export const MAX_PERSISTED_TABS = 50;

/** Tabs that should never be dropped, even when over the cap. */
function isPinnedKind(kind: PersistedTab['kind']): boolean {
  return kind === 'orchestrator' || kind === 'llm-chat';
}

/**
 * A tab is "clearly dead" if it carries no signal of live work. Conservative —
 * we'd rather keep something stale than drop an in-flight mission. Returns
 * `true` only for the obvious zombies.
 */
function isClearlyDeadTab(tab: PersistedTab): boolean {
  const kind = tab.kind ?? 'terminal';

  // chat (CLI Session): dead when no runtime session AND no saved checkpoints
  // AND no live orchestration packet attached. Packets indicate a dispatched
  // mission — that's live work even if the runtime session has rolled over.
  if (kind === 'chat') {
    const hasSessionKey = Boolean(tab.chatSessionKey?.trim());
    const hasCheckpoints = Boolean(tab.chatCheckpoints?.length);
    const hasPacket = Boolean(tab.orchestrationPacket);
    return !hasSessionKey && !hasCheckpoints && !hasPacket;
  }

  // terminal: drop pure dead leaves — no tmux session AND no repo binding.
  // Terminal tabs with a tmuxSession but no recent activity are kept because
  // we can't easily check tmux liveness from this layer (it's a client-side
  // helper); the restore path already handles that with `checkAliveSessions`.
  if (kind === 'terminal') {
    const hasTmuxSession = Boolean(tab.tmuxSession?.trim());
    const hasRepoPath = Boolean(tab.repoPath?.trim());
    return !hasTmuxSession && !hasRepoPath;
  }

  return false;
}

/**
 * Trim a persisted tab list down to a sane size. Always preserves the active
 * tab + Orchestrator + Assistant pins; drops obvious zombies first; falls back
 * to age-based trimming (array order = recency proxy) if still over cap.
 */
export function pruneTabs(
  tabs: PersistedTab[],
  activeTabId: string,
): { tabs: PersistedTab[]; dropped: number } {
  const original = tabs.length;
  if (original === 0) return { tabs, dropped: 0 };

  // Phase 1: drop clearly-dead tabs that aren't pinned + aren't the active tab.
  const survivors = tabs.filter((tab) => {
    if (tab.id === activeTabId) return true;
    if (isPinnedKind(tab.kind)) return true;
    return !isClearlyDeadTab(tab);
  });

  // Phase 2: if still over cap, trim oldest non-pinned tabs. The persisted
  // file has no per-tab timestamps, so we treat array order as a recency
  // proxy — newer tabs are appended later by the controller. Walk from the
  // FRONT of the array (oldest), dropping non-pinned, non-active tabs until
  // length <= MAX_PERSISTED_TABS.
  let pruned = survivors;
  if (pruned.length > MAX_PERSISTED_TABS) {
    const overflow = pruned.length - MAX_PERSISTED_TABS;
    const toDropIds = new Set<string>();
    for (let i = 0; i < pruned.length && toDropIds.size < overflow; i += 1) {
      const candidate = pruned[i];
      if (!candidate) continue;
      if (candidate.id === activeTabId) continue;
      if (isPinnedKind(candidate.kind)) continue;
      toDropIds.add(candidate.id);
    }
    if (toDropIds.size > 0) {
      pruned = pruned.filter((tab) => !toDropIds.has(tab.id));
    }
  }

  return { tabs: pruned, dropped: original - pruned.length };
}

function hashScopeKey(value: string) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return Math.abs(hash >>> 0).toString(36);
}

export function buildRepoStateScope(repoPath: string) {
  return `repo-${hashScopeKey(repoPath)}`;
}

export function formatPersistedRuntimeSessionKey(
  runtime?: PersistedTab['chatRuntime'],
  sessionKey?: string | null,
): PersistedRuntimeSessionKey | null {
  const trimmed = sessionKey?.trim();
  if (!trimmed || !runtime) return null;
  if (runtime === 'codex' && (
    trimmed.startsWith('codex:')
    || trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
  )) {
    return trimmed as PersistedRuntimeSessionKey;
  }
  if (runtime === 'gemini' && trimmed.startsWith('gemini-owned:')) {
    return trimmed as PersistedRuntimeSessionKey;
  }
  if (runtime === 'opencode' && trimmed.startsWith('opencode-owned:')) {
    return trimmed as PersistedRuntimeSessionKey;
  }
  if (runtime === 'codex' || runtime === 'claude-code') {
    return trimmed.startsWith(`${runtime}:`)
      ? trimmed as PersistedRuntimeSessionKey
      : `${runtime}:${trimmed}`;
  }
  // Gemini/opencode only use owned prefixes — any sessionKey without that
  // prefix isn't trackable as a persisted live runtime session for now.
  return null;
}

export function stripPersistedRuntimeSessionKey(
  runtime?: PersistedTab['chatRuntime'],
  sessionKey?: string | null,
) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) return undefined;
  if (!runtime) return trimmed;
  if (runtime === 'codex' && (
    trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
  )) {
    return trimmed;
  }
  // Owned CLI sessions for gemini/opencode keep their full prefixed key —
  // downstream dispatch paths (`/api/runtime/action`, owned-session-store,
  // `/api/mobile/history`) route on the prefix, so stripping would break them.
  if (runtime === 'gemini' && trimmed.startsWith('gemini-owned:')) {
    return trimmed;
  }
  if (runtime === 'opencode' && trimmed.startsWith('opencode-owned:')) {
    return trimmed;
  }
  return trimmed.startsWith(`${runtime}:`) ? trimmed.slice(`${runtime}:`.length) : trimmed;
}

export async function loadLiveRuntimeSessionKeys(): Promise<Set<PersistedRuntimeSessionKey>> {
  try {
    const res = await fetch('/api/runtime/inventory?fresh=1', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!res.ok) return new Set();
    const data = await res.json() as { agents?: Array<{ sessionKey?: string; runtime?: string }> };
    const keys = (data.agents ?? [])
      .map((agent) => agent.sessionKey?.trim())
      .filter((value): value is PersistedRuntimeSessionKey => {
        if (typeof value !== 'string' || !value) return false;
        return value.startsWith('codex:')
          || value.startsWith('codex-owned:')
          || value.startsWith('codex-discovered:')
          || value.startsWith('codex-live:')
          || value.startsWith('claude-code:');
      });
    return new Set(keys);
  } catch {
    return new Set();
  }
}

function buildStatePath(scope: string, repoPath?: string | null) {
  const params = new URLSearchParams();
  params.set('scope', scope);
  if (repoPath) {
    params.set('repoPath', repoPath);
  }
  return `${API_PATH}?${params.toString()}`;
}

/** Save tab state to server */
export async function saveTabState(state: PersistedTabState, scope = 'tile-root'): Promise<void> {
  try {
    const beforeCount = state.tabs.length;
    const { tabs: prunedTabs, dropped } = pruneTabs(state.tabs, state.activeTabId);
    if (dropped > 0) {
      console.log(`[tab-state] pruned ${dropped} tabs on save (was ${beforeCount}, now ${prunedTabs.length})`);
    }
    const persisted: PersistedTabState = dropped > 0
      ? { ...state, tabs: prunedTabs }
      : state;
    await fetch(buildStatePath(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(persisted),
    });
  } catch {
    // Non-critical — silent fail
  }
}

/** Load tab state from server */
export async function loadTabState(scope = 'tile-root', repoPath?: string | null): Promise<PersistedTabState | null> {
  try {
    const res = await fetch(buildStatePath(scope, repoPath));
    if (!res.ok) return null;
    const data = await res.json();
    if (data.version !== 1) return null;
    const state = data as PersistedTabState;
    if (!Array.isArray(state.tabs) || state.tabs.length === 0) return state;
    const beforeCount = state.tabs.length;
    const { tabs: prunedTabs, dropped } = pruneTabs(state.tabs, state.activeTabId);
    if (dropped > 0) {
      console.log(`[tab-state] pruned ${dropped} tabs on load (was ${beforeCount}, now ${prunedTabs.length})`);
      return { ...state, tabs: prunedTabs };
    }
    return state;
  } catch {
    return null;
  }
}

/** Check which tmux sessions from the saved state are still alive */
export async function checkAliveSessions(sessionNames: string[]): Promise<Set<string>> {
  try {
    const res = await fetch('/api/panel/terminal-sessions');
    if (!res.ok) return new Set();
    const data = await res.json();
    const alive = new Set<string>(data.sessions as string[]);
    return new Set(sessionNames.filter(s => alive.has(s)));
  } catch {
    return new Set();
  }
}
