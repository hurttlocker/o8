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

const paneThreads = new Set<string>();

export function registerPaneThread(threadId: string): void {
  paneThreads.add(threadId);
}

export function unregisterPaneThread(threadId: string): void {
  paneThreads.delete(threadId);
}

export function isPaneOwnedThread(threadId: string): boolean {
  return paneThreads.has(threadId);
}
