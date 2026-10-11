'use client';
import { useEffect, useState } from 'react';
import { isVisualizationReference, type VisualizationReference } from '@/lib/visualizations/types';

const EMPTY: VisualizationReference[] = [];
export function useTranscriptVisualizations(input: { repoPath?: string | null; threadId?: string | null; packetId?: string | null; active: boolean; length: number }) {
  const { repoPath, threadId, packetId, active, length } = input;
  const scope = packetId ? `packet:${packetId}` : repoPath && threadId?.startsWith('thoughts-') ? `${repoPath}::${threadId}` : '';
  const [snapshot, setSnapshot] = useState<{ scope: string; refs: VisualizationReference[] }>({ scope: '', refs: EMPTY });
  useEffect(() => {
    if (!scope || !active) return;
    const query: Record<string, string> = packetId ? { packetId } : { repoPath: repoPath!, threadId: threadId! };
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || controller.signal.aborted || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const response = await fetch(`/api/visualizations?${new URLSearchParams(query)}`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json() as { result?: { visualizations?: unknown[] } };
        if (response.ok && Array.isArray(body.result?.visualizations) && !controller.signal.aborted) {
          setSnapshot({ scope, refs: body.result.visualizations.filter(isVisualizationReference) });
        }
      } catch { /* Keep content through a missed poll. */ }
      finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [scope, active, repoPath, threadId, packetId, length]);
  return snapshot.scope === scope ? snapshot.refs : EMPTY;
}
