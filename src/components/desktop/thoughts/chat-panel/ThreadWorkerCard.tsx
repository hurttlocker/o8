'use client';

import { useEffect, useReducer, useState, type ComponentProps } from 'react';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { DEGRADED_FALLBACK_REFRESH_MS, startDurableRefresh } from '@/lib/panel/durable-refresh';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';
import { SwarmStatusCard, type SwarmSessionView } from './SwarmStatusCard';
import type { ThreadWorkerGroup } from './thread-worker-groups';

/** One thread membership subscription supplies every historical turn card. */
export function useThreadWorkers({ threadId, repoPath, busy, agents }: {
  threadId: string | null;
  repoPath: string | null;
  busy: boolean;
  agents: Array<{ sessionKey?: string; status?: string }>;
}) {
  const [saved, setSaved] = useState<{ threadId: string; workers: SwarmSessionView[] } | null>(null);
  const [refreshVersion, requestRefresh] = useReducer(value => value + 1, 0);
  useSharedDesktopWs(undefined, {
    onRealtimeEvent: event => {
      if (event.channel !== 'mutation') return;
      const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
      if (saved?.threadId === threadId && saved.workers.some(worker => worker.sessionKey === (mutation?.surfaceId ?? mutation?.sessionKey))) requestRefresh();
    },
  });
  useEffect(() => {
    if (!threadId || !repoPath) return;
    const controller = new AbortController();
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const response = await fetch(`/api/orchestrator/shared-team/active?repoPath=${encodeURIComponent(repoPath)}&threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as { threadId?: string; workers?: SwarmSessionView[] };
        if (!controller.signal.aborted && current === revision && payload.threadId === threadId && Array.isArray(payload.workers)) {
          setSaved({ threadId, workers: payload.workers });
        }
      } catch { /* Retain the last membership receipt; never infer new members from the repo. */ }
    };
    const launched = (event: Event) => {
      const detail = (event as CustomEvent<{ launchContext?: { parentThreadId?: string }; surfaceId?: string }>).detail;
      if (detail?.launchContext?.parentThreadId === threadId) void refresh();
    };
    void refresh();
    window.addEventListener('cortex:agent-supervisor-update', launched);
    const stopRefresh = startDurableRefresh({ refresh, intervalMs: DEGRADED_FALLBACK_REFRESH_MS, events: ['o8:lifecycle-reconcile'] });
    return () => { stopRefresh(); controller.abort(); window.removeEventListener('cortex:agent-supervisor-update', launched); };
  }, [threadId, repoPath, busy, refreshVersion]);
  const workers = saved?.threadId === threadId ? saved.workers : [];
  return workers.map(worker => ({ ...worker,
    status: agents.find(agent => agent.sessionKey === worker.sessionKey)?.status ?? worker.status,
  }));
}

export function ThreadWorkerCard({ group, unattributed = false, onFocusPacket, onFocusSession }: {
  group: ThreadWorkerGroup;
  unattributed?: boolean;
  onFocusPacket?: ComponentProps<typeof SwarmStatusCard>['onFocusPacket'];
  onFocusSession?: (sessionKey: string) => void;
}) {
  if (!group.packets.length && !group.sessions.length && !group.scouts.length) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    {unattributed ? <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)' }}>Subagents without a confirmed turn</span> : null}
    <SwarmStatusCard {...group} onFocusPacket={onFocusPacket} onFocusSession={onFocusSession} />
  </div>;
}
