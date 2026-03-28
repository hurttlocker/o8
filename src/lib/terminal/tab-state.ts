/**
 * Persisted terminal tab state — survives app restarts.
 * Stored per workspace tile under ~/.cortex-ide/terminal-states/<scope>.json
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
  kind?: 'terminal' | 'chat' | 'llm-chat' | 'canvas'; // defaults to 'terminal' for backward compat
  cliAgent: string; // 'shell' | 'claude' | 'codex' | etc
  repoName?: string;
  repoPath?: string;
  tmuxSession?: string; // last known tmux session name (may still be alive)
  chatRuntime?: 'codex' | 'claude-code' | 'openclaw'; // for kind='chat' (CLI Session)
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

export type PersistedRuntimeSessionKey = `codex:${string}` | `claude-code:${string}`;

const API_PATH = '/api/panel/terminal-state';

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
  if (!trimmed || (runtime !== 'codex' && runtime !== 'claude-code')) return null;
  return trimmed.startsWith(`${runtime}:`)
    ? trimmed as PersistedRuntimeSessionKey
    : `${runtime}:${trimmed}`;
}

export function stripPersistedRuntimeSessionKey(
  runtime?: PersistedTab['chatRuntime'],
  sessionKey?: string | null,
) {
  const trimmed = sessionKey?.trim();
  if (!trimmed) return undefined;
  if (runtime !== 'codex' && runtime !== 'claude-code') return trimmed;
  return trimmed.startsWith(`${runtime}:`) ? trimmed.slice(`${runtime}:`.length) : trimmed;
}

export async function loadLiveRuntimeSessionKeys(): Promise<Set<PersistedRuntimeSessionKey>> {
  try {
    const res = await fetch('/api/runtime/inventory?includeOpenClaw=0&fresh=1', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!res.ok) return new Set();
    const data = await res.json() as { agents?: Array<{ sessionKey?: string; runtime?: string }> };
    const keys = (data.agents ?? [])
      .map((agent) => agent.sessionKey?.trim())
      .filter((value): value is PersistedRuntimeSessionKey => {
        if (typeof value !== 'string' || !value) return false;
        return value.startsWith('codex:') || value.startsWith('claude-code:');
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
    await fetch(buildStatePath(scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
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
    return data as PersistedTabState;
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
