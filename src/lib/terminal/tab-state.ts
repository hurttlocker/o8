/**
 * Persisted terminal tab state — survives app restarts.
 * Stored per workspace tile under ~/.cortex-ide/terminal-states/<scope>.json
 */

import type { MobileTranscriptEntry } from '@/lib/mobile/types';

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

const API_PATH = '/api/panel/terminal-state';

function buildStatePath(scope: string) {
  const params = new URLSearchParams();
  params.set('scope', scope);
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
export async function loadTabState(scope = 'tile-root'): Promise<PersistedTabState | null> {
  try {
    const res = await fetch(buildStatePath(scope));
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
