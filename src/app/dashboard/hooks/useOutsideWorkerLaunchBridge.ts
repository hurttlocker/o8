'use client';

import { useEffect } from 'react';
import { runtimeFromWorkerSessionKey, shouldPresentWorkerInSplit } from '@/lib/orchestrator/worker-launch-context';
import type { WorkerLaunchContext } from '@/lib/orchestrator/types';
import type { DispatchedWorkerLane } from './dispatched-worker-lane';

interface SupervisorLaunchDetail {
  surfaceId?: string;
  name?: string;
  status?: string;
  repoPath?: string;
  launchContext?: WorkerLaunchContext;
}

export function useOutsideWorkerLaunchBridge(openWorker: (lane: DispatchedWorkerLane) => Promise<void>): void {
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
}
