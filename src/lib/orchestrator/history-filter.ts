/**
 * Pure filter for the orchestrator history sidebar. Matches a query against
 * the thread title and the first user message (when available). Case-insensitive
 * substring match — no fuzzy library.
 */

export interface FilterableThread {
  title: string;
  firstUserMessage?: string | null;
}

export function filterThreads<T extends FilterableThread>(threads: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return threads;
  return threads.filter((thread) => {
    if (thread.title.toLowerCase().includes(needle)) return true;
    const firstMessage = thread.firstUserMessage;
    if (firstMessage && firstMessage.toLowerCase().includes(needle)) return true;
    return false;
  });
}
