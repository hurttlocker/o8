/**
 * orchestrator-thread-restore — localStorage helpers for restoring the
 * last-active orchestrator thread across reloads.
 *
 * Both pieces — the thread id (which file to load) AND the title
 * (what to show in the header BEFORE the file's contents arrive) —
 * are persisted together so the default Orchestrator tab can spawn
 * with the right label on first paint, no flash from "Orchestrator"
 * to "o8.v1".
 *
 * Scoped PER REPO (Fix 2): the keys are suffixed with a stable repo
 * identifier so repo B can't resurrect repo A's last thread. Callers pass
 * the tab's repo localPath as `repoScope`; a null scope (free-floating,
 * repo-less orchestrator) operates on the un-suffixed legacy bucket.
 *
 * Migration: a scoped read with no per-repo value falls back to the legacy
 * global key ONCE so existing users don't lose their restore; the first
 * successful scoped write then deletes the legacy keys so they can't shadow
 * a different repo later.
 */

const LEGACY_ID_KEY = 'o8:last-orchestrator-thread-id';
const LEGACY_TITLE_KEY = 'o8:last-orchestrator-thread-title';
const LEGACY_TITLE_ID_KEY = 'o8:last-orchestrator-thread-title-id';

function normalizeRepoScope(repoScope: string | null | undefined): string | null {
  if (!repoScope) return null;
  const trimmed = repoScope.trim().replace(/\/+$/, '');
  return trimmed || null;
}

function idKey(scope: string | null): string {
  return scope ? `${LEGACY_ID_KEY}::${scope}` : LEGACY_ID_KEY;
}
function titleKey(scope: string | null): string {
  return scope ? `${LEGACY_TITLE_KEY}::${scope}` : LEGACY_TITLE_KEY;
}
function titleIdKey(scope: string | null): string {
  return scope ? `${LEGACY_TITLE_ID_KEY}::${scope}` : LEGACY_TITLE_ID_KEY;
}

export function readLastOrchestratorThreadId(repoScope?: string | null): string | null {
  if (typeof window === 'undefined') return null;
  const scope = normalizeRepoScope(repoScope);
  try {
    const scoped = window.localStorage.getItem(idKey(scope));
    if (scoped !== null) return scoped;
    // Migration: no per-repo value yet — fall back to the legacy global key
    // once (a null scope already reads the legacy key above).
    if (scope) return window.localStorage.getItem(LEGACY_ID_KEY);
    return null;
  } catch {
    return null;
  }
}

export function readLastOrchestratorThreadTitle(repoScope?: string | null): string | null {
  if (typeof window === 'undefined') return null;
  const scope = normalizeRepoScope(repoScope);
  try {
    // Resolve the thread id first (mirroring readLastOrchestratorThreadId's
    // legacy fallback) so the title is only returned when it belongs to the
    // id we'd actually restore.
    let threadId = window.localStorage.getItem(idKey(scope));
    let fromLegacy = false;
    if (threadId === null && scope) {
      threadId = window.localStorage.getItem(LEGACY_ID_KEY);
      fromLegacy = true;
    }
    if (!threadId) return null;
    const tIdKey = fromLegacy ? LEGACY_TITLE_ID_KEY : titleIdKey(scope);
    const tKey = fromLegacy ? LEGACY_TITLE_KEY : titleKey(scope);
    const titleThreadId = window.localStorage.getItem(tIdKey);
    if (titleThreadId !== threadId) return null;
    return window.localStorage.getItem(tKey);
  } catch {
    return null;
  }
}

/** Persist the active thread id, and optionally its title, for `repoScope`.
 *  Always call with the tab's repo scope; pass `threadId = null` to clear. */
export function writeLastOrchestratorThread(
  repoScope: string | null | undefined,
  threadId: string | null,
  title?: string | null,
): void {
  if (typeof window === 'undefined') return;
  const scope = normalizeRepoScope(repoScope);
  try {
    if (threadId) {
      window.localStorage.setItem(idKey(scope), threadId);
    } else {
      window.localStorage.removeItem(idKey(scope));
    }
    if (title !== undefined) {
      if (title && title.trim()) {
        window.localStorage.setItem(titleKey(scope), title.trim());
        if (threadId) window.localStorage.setItem(titleIdKey(scope), threadId);
      } else {
        window.localStorage.removeItem(titleKey(scope));
        window.localStorage.removeItem(titleIdKey(scope));
      }
    }
    // Migration: once a per-repo bucket has been written, the legacy global
    // keys have served their one-time fallback — drop them so they can't
    // resurrect this thread into a DIFFERENT repo on a later read.
    if (scope) {
      window.localStorage.removeItem(LEGACY_ID_KEY);
      window.localStorage.removeItem(LEGACY_TITLE_KEY);
      window.localStorage.removeItem(LEGACY_TITLE_ID_KEY);
    }
  } catch {
    // ignore
  }
}

/** Clear the restore keys — in ANY repo bucket (plus legacy) — that currently
 *  point at `threadId`. Thread ids are globally unique, so a deleted chat is
 *  swept from every scope without the caller needing to know which repo owned
 *  it (used by ChatsTab on delete, where the repo scope may be unknown). */
export function clearLastOrchestratorThreadForId(threadId: string): void {
  if (typeof window === 'undefined' || !threadId) return;
  try {
    const store = window.localStorage;
    const prefix = `${LEGACY_ID_KEY}::`;
    const matchedScopes: (string | null)[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key) continue;
      if (key !== LEGACY_ID_KEY && !key.startsWith(prefix)) continue;
      if (store.getItem(key) !== threadId) continue;
      matchedScopes.push(key === LEGACY_ID_KEY ? null : key.slice(prefix.length));
    }
    // Collected first, then cleared, so we never mutate mid-iteration.
    for (const scope of matchedScopes) {
      writeLastOrchestratorThread(scope, null, null);
    }
  } catch {
    // ignore
  }
}
