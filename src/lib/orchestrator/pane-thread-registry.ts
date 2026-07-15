/**
 * pane-thread-registry — module-level set of thread ids currently open as
 * drag-to-split thread panes (ThreadChatPane mounts register here).
 *
 * Why: every chat view on a repo shares the orchestrator WS channel, and a
 * view with NO thread bound (fresh empty orchestrator tab) deliberately
 * reattaches to any in-flight turn for its repo (durable-turn recovery).
 * When a thread PANE fires a turn, that recovery path would hijack the
 * empty main chat with the pane's turn (live-hit 2026-07-15). The stream
 * ingest guard consults this registry: events for a pane-owned thread are
 * dropped by every view except the pane that owns it.
 */

// Reference-counted, NOT a plain Set: the same thread can be open in more than
// one pane (drag the same history row into two workspace tabs). A Set records a
// single entry, so closing EITHER pane deleted it and silently disabled the
// ingest guard for the pane still mounted (adversarial review 2026-07-15).
// Count mounts; the thread stays owned until the last pane unregisters.
const paneThreadCounts = new Map<string, number>();

export function registerPaneThread(threadId: string): void {
  paneThreadCounts.set(threadId, (paneThreadCounts.get(threadId) ?? 0) + 1);
}

export function unregisterPaneThread(threadId: string): void {
  const next = (paneThreadCounts.get(threadId) ?? 0) - 1;
  if (next > 0) {
    paneThreadCounts.set(threadId, next);
  } else {
    paneThreadCounts.delete(threadId);
  }
}

export function isPaneOwnedThread(threadId: string): boolean {
  return paneThreadCounts.has(threadId);
}
