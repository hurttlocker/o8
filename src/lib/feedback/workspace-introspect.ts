'use client';

/**
 * Workspace-state introspection for bug-report forensics (report GQXEZD —
 * "New session does nothing" on a machine we can't see).
 *
 * The report pipeline already carries geometry + the console-error ring
 * buffer, but the session-create class fails SILENTLY: the spawn promise
 * resolves, no error fires, and the only open question is "which tile/tab
 * state did the click land in?" — state that lives across two hooks and
 * per-tile React state. This module lets those owners contribute a snapshot
 * at report time without coupling the report client to dashboard internals:
 *
 *   - Live surfaces register a contributor (keyed, replace-on-remount) that
 *     returns their slice of state when a report is filed.
 *   - Spawn paths record breadcrumbs into a small in-memory journal (what
 *     was clicked, which tile resolved, which tab id came back) so "nothing
 *     happened" reports show exactly where the spawn went.
 *
 * Everything is best-effort: a throwing contributor yields an error string,
 * never blocks the report. Also exposed as `window.__o8Introspect()` so a
 * driving agent (o8_view_eval) can read the same truth live.
 */

export interface SpawnJournalEntry {
  /** epoch ms */
  ts: number;
  /** e.g. "orchestrator:requested", "orchestrator:resolved tile=...", "spawn:fresh tab=..." */
  event: string;
}

const contributors = new Map<string, () => unknown>();
const spawnJournal: SpawnJournalEntry[] = [];
const SPAWN_JOURNAL_CAP = 20;

/** Register a snapshot contributor. Re-registering a key replaces it (remount
 *  semantics). Returns an unregister function for effect cleanup. */
export function registerIntrospectionContributor(key: string, fn: () => unknown): () => void {
  contributors.set(key, fn);
  return () => {
    // Only delete if WE are still the registered contributor — a remount may
    // have replaced the entry before the old cleanup ran.
    if (contributors.get(key) === fn) contributors.delete(key);
  };
}

/** Record a spawn breadcrumb (ring-buffered, newest last). */
export function recordSpawnEvent(event: string): void {
  spawnJournal.push({ ts: Date.now(), event: String(event).slice(0, 300) });
  if (spawnJournal.length > SPAWN_JOURNAL_CAP) spawnJournal.splice(0, spawnJournal.length - SPAWN_JOURNAL_CAP);
}

export function readSpawnJournal(): SpawnJournalEntry[] {
  return [...spawnJournal];
}

/** Collect every contributor's snapshot. Per-contributor failures become
 *  error strings so one bad snapshot never hides the others. */
export function collectWorkspaceIntrospection(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, fn] of contributors) {
    try {
      out[key] = fn();
    } catch (error) {
      out[key] = `introspection failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return out;
}

// Live debug hook for agents driving the webview (mcp o8_view_eval).
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__o8Introspect = () => ({
    workspace: collectWorkspaceIntrospection(),
    spawnJournal: readSpawnJournal(),
  });
}
