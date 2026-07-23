import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const STATE_DIR = getDataDir();
const STATE_SCOPE_DIR = path.join(STATE_DIR, 'terminal-states');
const LEGACY_STATE_FILE = path.join(STATE_DIR, 'terminal-state.json');

interface TerminalStateTab {
  id?: string;
  repoPath?: string | null;
  /** Last-known tmux session name (set for persistent dash terminals). */
  tmuxSession?: string | null;
}

interface TerminalStateFile {
  activeTabId?: string;
  savedAt?: string;
  tabs?: TerminalStateTab[];
}

function normalizeScopePath(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, os.homedir())).replace(/\/+$/, '');
}

function pathBelongsToRepoScope(candidatePath?: string | null, repoPath?: string | null) {
  const candidate = normalizeScopePath(candidatePath);
  const repo = normalizeScopePath(repoPath);
  if (!candidate || !repo) return false;
  return candidate === repo || candidate.startsWith(`${repo}/`);
}

function readTerminalState(filePath: string): TerminalStateFile | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as TerminalStateFile;
  } catch {
    return null;
  }
}

function writeTerminalState(filePath: string, state: TerminalStateFile) {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  if (!existsSync(STATE_SCOPE_DIR)) {
    mkdirSync(STATE_SCOPE_DIR, { recursive: true });
  }
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function pruneTerminalStateForRepoPath(repoPath: string) {
  const normalizedRepoPath = normalizeScopePath(repoPath);
  if (!normalizedRepoPath) {
    return {
      prunedTabs: 0,
      updatedFiles: 0,
      removedFiles: 0,
    };
  }

  const scopeFiles = existsSync(STATE_SCOPE_DIR)
    ? readdirSync(STATE_SCOPE_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(STATE_SCOPE_DIR, file))
    : [];
  const fileSet = new Set<string>(scopeFiles);
  if (existsSync(LEGACY_STATE_FILE)) {
    fileSet.add(LEGACY_STATE_FILE);
  }

  let prunedTabs = 0;
  let updatedFiles = 0;
  let removedFiles = 0;

  for (const filePath of fileSet) {
    const parsed = readTerminalState(filePath);
    if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
      continue;
    }

    const remainingTabs = parsed.tabs.filter((tab) => !pathBelongsToRepoScope(tab.repoPath, normalizedRepoPath));
    if (remainingTabs.length === parsed.tabs.length) {
      continue;
    }

    prunedTabs += parsed.tabs.length - remainingTabs.length;
    if (remainingTabs.length === 0) {
      rmSync(filePath, { force: true });
      removedFiles += 1;
      continue;
    }

    const nextActiveTabId = remainingTabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : remainingTabs[0]?.id;

    writeTerminalState(filePath, {
      ...parsed,
      activeTabId: nextActiveTabId,
      tabs: remainingTabs,
      savedAt: new Date().toISOString(),
    });
    updatedFiles += 1;
  }

  const tileRootStateFile = path.join(STATE_SCOPE_DIR, 'tile-root.json');
  if (!existsSync(tileRootStateFile) && existsSync(LEGACY_STATE_FILE)) {
    const legacy = readTerminalState(LEGACY_STATE_FILE);
    if (legacy?.tabs?.length) {
      writeTerminalState(tileRootStateFile, legacy);
    } else {
      rmSync(LEGACY_STATE_FILE, { force: true });
    }
  } else if (existsSync(tileRootStateFile)) {
    const tileRootState = readTerminalState(tileRootStateFile);
    if (tileRootState?.tabs?.length) {
      writeTerminalState(LEGACY_STATE_FILE, tileRootState);
    } else {
      rmSync(LEGACY_STATE_FILE, { force: true });
    }
  }

  return {
    prunedTabs,
    updatedFiles,
    removedFiles,
  };
}

/**
 * #6 persistent terminals — collect every tmux session name referenced by a
 * persisted tab across all scope files (+ the legacy file). This is the durable
 * "is this session still owned by a tab?" source the dash-session GC keys on —
 * NOT the in-memory attachment map, which is empty after a crash. On any read
 * failure the caller must treat the result as authoritative-empty-only when it
 * also succeeded reading tmux; callers should skip GC entirely if this throws.
 */
export function collectPersistedTmuxSessions(): Set<string> {
  const sessions = new Set<string>();

  const fileSet = new Set<string>(
    existsSync(STATE_SCOPE_DIR)
      ? readdirSync(STATE_SCOPE_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(STATE_SCOPE_DIR, file))
      : [],
  );
  if (existsSync(LEGACY_STATE_FILE)) {
    fileSet.add(LEGACY_STATE_FILE);
  }

  for (const filePath of fileSet) {
    const parsed = readTerminalState(filePath);
    if (!parsed || !Array.isArray(parsed.tabs)) continue;
    for (const tab of parsed.tabs) {
      const name = tab.tmuxSession?.trim();
      if (name) sessions.add(name);
    }
  }

  return sessions;
}

export function getTerminalStateMtime(filePath: string) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
