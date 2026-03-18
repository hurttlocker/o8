/**
 * Persisted terminal tab state — survives app restarts.
 * Stored at ~/.cortex-ide/terminal-state.json
 */

export interface PersistedTab {
  id: string;
  label: string;
  cliAgent: string; // 'shell' | 'claude' | 'codex' | etc
  repoName?: string;
  repoPath?: string;
  tmuxSession?: string; // last known tmux session name (may still be alive)
}

export interface PersistedTabState {
  version: 1;
  activeTabId: string;
  tabs: PersistedTab[];
  savedAt: string; // ISO timestamp
}

const STATE_PATH = '~/.cortex-ide/terminal-state.json';
const API_PATH = '/api/panel/terminal-state';

/** Save tab state to server */
export async function saveTabState(state: PersistedTabState): Promise<void> {
  try {
    await fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch {
    // Non-critical — silent fail
  }
}

/** Load tab state from server */
export async function loadTabState(): Promise<PersistedTabState | null> {
  try {
    const res = await fetch(API_PATH);
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
