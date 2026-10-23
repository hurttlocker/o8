import { useEffect, useState } from 'react';
import { isGenericWorkerTitle, workerTabLabels } from '../workspace-terminal/worker-pane-chrome';
import type { WorkspaceHeaderTab } from './workspace-header-strip-types';

function threadIdFor(tab: WorkspaceHeaderTab): string | null {
  if (tab.kind === 'llm-chat') return tab.id;
  if (tab.kind !== 'orchestrator') return null;
  return tab.orchestratorThreadId || (tab.id.startsWith('thoughts-') ? tab.id : null);
}

export function useWorkspaceHeaderTabLabels(tabs: readonly WorkspaceHeaderTab[]): string[] {
  const [savedTitles, setSavedTitles] = useState<Record<string, string>>({});
  const threadIdsKey = JSON.stringify([...new Set(tabs.map(threadIdFor).filter((id): id is string => Boolean(id)))].sort());

  useEffect(() => {
    const threadIds = new Set<string>(JSON.parse(threadIdsKey));
    if (threadIds.size === 0) return;
    const controller = new AbortController();
    let request = 0;
    const sync = async () => {
      const current = ++request;
      try {
        // Restored, unvisited tabs have no mounted chat panel. Read only the
        // persisted metadata list, never their complete transcripts.
        const res = await fetch('/api/v2/chat-history/list?include=orchestrator&archived=include', { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        if (controller.signal.aborted || current !== request || !Array.isArray(data?.conversations)) return;
        const next: Record<string, string> = {};
        for (const entry of data.conversations) {
          if (!threadIds.has(entry.tabId)) continue;
          const title = typeof entry.title === 'string' ? entry.title.trim() : '';
          const summary = typeof entry.firstUserMessage === 'string' ? entry.firstUserMessage.trim() : '';
          const resolved = title && !isGenericWorkerTitle(title) ? title : summary;
          if (resolved) next[entry.tabId] = resolved;
        }
        setSavedTitles(next);
      } catch { /* Live summaries and numbered fallbacks remain usable offline. */ }
    };
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; tabId?: string }>).detail;
      const id = detail?.threadId ?? detail?.tabId;
      if (id && threadIds.has(id)) void sync();
    };
    void sync();
    const events = ['o8:thread-title-maybe-updated', 'o8:chat-history-updated', 'o8:chat-history-deleted'];
    for (const event of events) window.addEventListener(event, onUpdate);
    return () => {
      controller.abort();
      for (const event of events) window.removeEventListener(event, onUpdate);
    };
  }, [threadIdsKey]);

  return workerTabLabels(tabs.map(tab => ({ ...tab, llmSummary: savedTitles[threadIdFor(tab) ?? ''] ?? tab.llmSummary })));
}
