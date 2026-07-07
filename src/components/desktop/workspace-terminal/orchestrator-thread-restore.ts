/**
 * orchestrator-thread-restore — localStorage helpers for restoring the
 * last-active orchestrator thread across reloads.
 *
 * Both pieces — the thread id (which file to load) AND the title
 * (what to show in the header BEFORE the file's contents arrive) —
 * are persisted together so the default Orchestrator tab can spawn
 * with the right label on first paint, no flash from "Orchestrator"
 * to "o8.v1".
 */

const THREAD_ID_KEY = 'o8:last-orchestrator-thread-id';
const THREAD_TITLE_KEY = 'o8:last-orchestrator-thread-title';
const THREAD_TITLE_ID_KEY = 'o8:last-orchestrator-thread-title-id';

export function readLastOrchestratorThreadId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(THREAD_ID_KEY);
  } catch {
    return null;
  }
}

export function readLastOrchestratorThreadTitle(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const threadId = window.localStorage.getItem(THREAD_ID_KEY);
    const titleThreadId = window.localStorage.getItem(THREAD_TITLE_ID_KEY);
    if (!threadId || titleThreadId !== threadId) return null;
    return window.localStorage.getItem(THREAD_TITLE_KEY);
  } catch {
    return null;
  }
}

/** Persist the active thread id, and optionally its title. Always
 *  call with both when known; pass `null` to clear. */
export function writeLastOrchestratorThread(threadId: string | null, title?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (threadId) {
      window.localStorage.setItem(THREAD_ID_KEY, threadId);
    } else {
      window.localStorage.removeItem(THREAD_ID_KEY);
    }
    if (title !== undefined) {
      if (title && title.trim()) {
        window.localStorage.setItem(THREAD_TITLE_KEY, title.trim());
        if (threadId) window.localStorage.setItem(THREAD_TITLE_ID_KEY, threadId);
      } else {
        window.localStorage.removeItem(THREAD_TITLE_KEY);
        window.localStorage.removeItem(THREAD_TITLE_ID_KEY);
      }
    }
  } catch {
    // ignore
  }
}
