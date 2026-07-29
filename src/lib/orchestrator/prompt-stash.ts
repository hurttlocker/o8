export const PROMPT_STASH_STORAGE_KEY = 'o8:prompt-stash';
export const PROMPT_STASH_LIMIT = 50;

const PROMPT_STASH_CHANGE_EVENT = 'o8:prompt-stash-change';

export interface PromptStashEntry {
  id: string;
  text: string;
  repoPath: string;
  threadId: string | null;
  createdAt: number;
}

export interface PromptStashContext {
  repoPath: string;
  threadId: string | null;
}

function getPromptStashStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPromptStashEntry(value: unknown): value is PromptStashEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PromptStashEntry>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.text === 'string'
    && candidate.text.trim().length > 0
    && typeof candidate.repoPath === 'string'
    && candidate.repoPath.length > 0
    && (candidate.threadId === null || typeof candidate.threadId === 'string')
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt);
}

function createPromptStashId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `prompt-stash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function notifyPromptStashChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PROMPT_STASH_CHANGE_EVENT));
}

function writePromptStash(entries: PromptStashEntry[]): boolean {
  const storage = getPromptStashStorage();
  if (!storage) return false;
  try {
    storage.setItem(PROMPT_STASH_STORAGE_KEY, JSON.stringify(entries.slice(0, PROMPT_STASH_LIMIT)));
    notifyPromptStashChanged();
    return true;
  } catch {
    return false;
  }
}

export function listPromptStash(): PromptStashEntry[] {
  const storage = getPromptStashStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(PROMPT_STASH_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      storage.removeItem(PROMPT_STASH_STORAGE_KEY);
      return [];
    }
    return parsed.filter(isPromptStashEntry).slice(0, PROMPT_STASH_LIMIT);
  } catch {
    try {
      storage.removeItem(PROMPT_STASH_STORAGE_KEY);
    } catch {
      // Storage may be unavailable entirely. The in-memory composer stays intact.
    }
    return [];
  }
}

export function stashPrompt(
  draft: PromptStashContext & { text: string },
): PromptStashEntry | null {
  if (!draft.text.trim()) return null;
  const entry: PromptStashEntry = {
    id: createPromptStashId(),
    text: draft.text,
    repoPath: draft.repoPath || '~',
    threadId: draft.threadId,
    createdAt: Date.now(),
  };
  const next = [entry, ...listPromptStash()].slice(0, PROMPT_STASH_LIMIT);
  return writePromptStash(next) ? entry : null;
}

export function popPromptStash(id: string): PromptStashEntry | null {
  const entries = listPromptStash();
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  const next = entries.filter((candidate) => candidate.id !== id);
  return writePromptStash(next) ? entry : null;
}

export function deletePromptStash(id: string): boolean {
  const entries = listPromptStash();
  if (!entries.some((entry) => entry.id === id)) return false;
  return writePromptStash(entries.filter((entry) => entry.id !== id));
}

export function subscribePromptStash(
  listener: (entries: PromptStashEntry[]) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const refresh = () => listener(listPromptStash());
  const handleStorage = (event: StorageEvent) => {
    if (event.key === PROMPT_STASH_STORAGE_KEY || event.key === null) refresh();
  };
  window.addEventListener(PROMPT_STASH_CHANGE_EVENT, refresh);
  window.addEventListener('storage', handleStorage);
  refresh();
  return () => {
    window.removeEventListener(PROMPT_STASH_CHANGE_EVENT, refresh);
    window.removeEventListener('storage', handleStorage);
  };
}
