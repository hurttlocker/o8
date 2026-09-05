'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TaskArtifactView } from '@/lib/task-artifacts/types';

const POLL_MS = 5_000;
const EMPTY: TaskArtifactView[] = [];

/**
 * The task artifacts attached to one orchestrator thread (#1699). Artifacts
 * are created server-side by an agent's tool call, so the transcript learns
 * about them by asking, not from the stream: a bounded poll while the panel is
 * visible, kicked again whenever the transcript grows.
 */
export function useTaskArtifacts(input: { repoPath: string | null; threadId: string | null; enabled: boolean; transcriptLength: number }) {
  const { repoPath, threadId, enabled, transcriptLength } = input;
  const scope = enabled && repoPath && threadId ? `${repoPath}::${threadId}` : '';
  // The snapshot remembers which thread it belongs to, so switching threads
  // renders nothing until the first fetch for the new thread lands.
  const [snapshot, setSnapshot] = useState<{ scope: string; artifacts: TaskArtifactView[] }>({ scope: '', artifacts: EMPTY });

  const refresh = useCallback(async () => {
    if (!scope || !repoPath || !threadId) return;
    try {
      const params = new URLSearchParams({ threadId, repoPath });
      const response = await fetch(`/api/task-artifacts?${params.toString()}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { ok?: boolean; result?: { artifacts?: TaskArtifactView[] } } | null;
      if (!response.ok || !body?.ok || !Array.isArray(body.result?.artifacts)) return;
      setSnapshot({ scope, artifacts: body.result!.artifacts! });
    } catch {
      // A missed poll is not an error state; the next tick retries.
    }
  }, [repoPath, scope, threadId]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled && document.visibilityState === 'visible') void refresh();
    };
    // A new transcript entry is the moment an agent turn may have attached one,
    // so each transcript change restarts the poll with an immediate tick.
    const kick = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(kick);
      window.clearInterval(timer);
    };
  }, [scope, refresh, transcriptLength]);

  return { artifacts: snapshot.scope === scope ? snapshot.artifacts : EMPTY, refresh };
}
