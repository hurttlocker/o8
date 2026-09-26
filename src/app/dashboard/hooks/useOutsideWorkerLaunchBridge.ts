'use client';

import { useEffect } from 'react';
import { runtimeFromWorkerSessionKey, shouldPresentWorkerInSplit } from '@/lib/orchestrator/worker-launch-context';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';
import { dispatchedWorkerRuntime, type DispatchedWorkerLane } from './dispatched-worker-lane';

interface SupervisorLaunchDetail {
  surfaceId?: string;
  name?: string;
  status?: string;
  repoPath?: string;
  launchContext?: WorkerLaunchContext;
}

interface SharedTeamMember {
  surfaceId: string | null;
  runtime: string;
  taskName: string;
  state: 'reserved' | 'running' | 'failed';
  outcome?: 'running' | 'finished' | 'interrupted' | 'failed' | 'unknown';
}

interface ActiveSharedTeam {
  repoPath: string;
  parentThreadId: string;
  members: SharedTeamMember[];
}

export function sharedTeamWorkerLanes(team: ActiveSharedTeam): DispatchedWorkerLane[] {
  return team.members.flatMap((member) => {
    if (member.state !== 'running' || !member.surfaceId) return [];
    return [{
      sessionKey: member.surfaceId,
      runtime: dispatchedWorkerRuntime(member.runtime),
      repoPath: team.repoPath,
      status: member.outcome === 'running' ? 'running'
        : member.outcome === 'finished' ? 'completed'
          : member.outcome ?? 'unknown',
      packetTitle: member.taskName,
      launchContext: {
        source: 'agent' as const,
        presentation: 'split' as const,
        repoContext: 'registered' as const,
        caller: 'orchestrator',
        parentThreadId: team.parentThreadId,
        checkoutMode: 'shared' as const,
      },
    }];
  });
}

export function useOutsideWorkerLaunchBridge(
  openWorker: (lane: DispatchedWorkerLane) => Promise<void>,
  repoPaths: ReadonlyArray<string>,
): void {
  useEffect(() => {
    const handleSupervisorLaunch = (event: Event) => {
      const detail = (event as CustomEvent<SupervisorLaunchDetail>).detail;
      if (!detail?.surfaceId || !detail.repoPath || detail.status !== 'launched') return;
      if (!shouldPresentWorkerInSplit(detail.launchContext)) return;
      void openWorker({
        sessionKey: detail.surfaceId,
        runtime: runtimeFromWorkerSessionKey(detail.surfaceId),
        repoPath: detail.repoPath,
        status: 'launching',
        packetTitle: detail.name ?? 'Dispatched Agent',
        launchContext: detail.launchContext,
      });
    };
    window.addEventListener('cortex:agent-supervisor-update', handleSupervisorLaunch);
    return () => window.removeEventListener('cortex:agent-supervisor-update', handleSupervisorLaunch);
  }, [openWorker]);

  const repoKey = [...new Set(repoPaths)].sort().join('\n');
  useEffect(() => {
    if (!repoKey) return undefined;
    const abort = new AbortController();
    for (const repoPath of repoKey.split('\n')) {
      void fetch(`/api/orchestrator/shared-team/active?repoPath=${encodeURIComponent(repoPath)}`, {
        signal: abort.signal,
      }).then(async (response) => {
        if (!response.ok || abort.signal.aborted) return;
        const body = await response.json() as { team?: ActiveSharedTeam | null };
        if (!body.team || abort.signal.aborted) return;
        for (const lane of sharedTeamWorkerLanes(body.team)) void openWorker(lane);
      }).catch(() => { /* The live launch bridge remains available during API outages. */ });
    }
    return () => abort.abort();
  }, [openWorker, repoKey]);
}
