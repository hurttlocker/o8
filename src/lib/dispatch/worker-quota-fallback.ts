import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
} from '@/lib/orchestrator/cross-house-policy';
import { resolveCrossHouseWorkerFallbackSync, getOperatorDefaultsSync } from '@/lib/operator/defaults';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';

const RECENT_FALLBACK_WINDOW_MS = 10 * 60_000;

function backendForRuntime(runtime: string): 'codex' | 'claude' | null {
  if (runtime === 'codex') return 'codex';
  if (runtime === 'claude-code') return 'claude';
  return null;
}

export interface WorkerQuotaFallbackResult {
  handled: boolean;
  action: 'ignored' | 'card' | 'redispatched';
  toRuntime?: OrchestratorRuntime;
  inboxId?: string;
  sessionKey?: string;
}

/** Runtime-adapter exit seam. Keeping detection here lets tests drive the same
 * path as a real Codex or Claude child-process failure. */
export async function handleWorkerRuntimeFailure(input: {
  laneId: string;
  runtime: string;
  model?: string;
  surfaceId: string;
  prompt: string;
  rawFailure: string;
}): Promise<WorkerQuotaFallbackResult> {
  if (!isRuntimeQuotaLimitError(input.rawFailure)) {
    return { handled: false, action: 'ignored' };
  }
  return handleWorkerQuotaExhaustion({
    laneId: input.laneId,
    runtime: input.runtime,
    model: input.model,
    surfaceId: input.surfaceId,
    prompt: input.prompt,
    error: input.rawFailure,
  });
}

export async function handleWorkerQuotaExhaustion(input: {
  laneId: string;
  runtime: string;
  model?: string;
  surfaceId: string;
  prompt: string;
  error: string;
}): Promise<WorkerQuotaFallbackResult> {
  const backend = backendForRuntime(input.runtime);
  if (!backend) return { handled: false, action: 'ignored' };

  const [{ getLane, getLaneEvents, setLaneStatus, attachSession }, { recordLaneEvent }, { rebindLaneRuntime }] = await Promise.all([
    import('@/lib/lane/registry'),
    import('@/lib/lane/events'),
    import('@/lib/lane/runtime-rebind'),
  ]);
  const lane = getLane(input.laneId);
  if (!lane) return { handled: false, action: 'ignored' };

  const decision = resolveCrossHouseFallback({
    role: 'worker',
    backend,
    model: input.model,
    subscriptionProfile: getOperatorDefaultsSync().values.subscriptionProfile,
  });
  if (!decision) return { handled: false, action: 'ignored' };

  const payload = {
    laneId: lane.id,
    packetId: lane.packetId,
    surfaceId: input.surfaceId,
    fromRuntime: input.runtime,
    suggestedRuntime: decision.toRuntime,
    fromModel: decision.fromModel,
    suggestedModel: decision.toModel,
    runtimeTier: decision.runtimeTier,
    error: input.error.slice(0, 2_000),
    note: buildCrossHouseFallbackMessage(decision),
  };
  recordLaneEvent(lane.id, 'worker_quota_exhausted', 'system', payload);

  const recentFallback = getLaneEvents(lane.id, 100).find((event) => (
    event.verb === 'worker_fallback'
    && Date.now() - new Date(event.timestamp).getTime() < RECENT_FALLBACK_WINDOW_MS
  ));
  const autoFallback = resolveCrossHouseWorkerFallbackSync()
    && decision.action === 'handoff'
    && !recentFallback;

  if (!autoFallback) {
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        ...payload,
        fallbackAlreadyTried: Boolean(recentFallback),
        autoFallbackEnabled: resolveCrossHouseWorkerFallbackSync(),
      },
    });
    return { handled: true, action: 'card', toRuntime: decision.toRuntime, inboxId: item.id };
  }

  rebindLaneRuntime(lane.id, decision.toRuntime, {
    reason: 'cross_house_worker_fallback',
    fromRuntime: lane.runtime,
    toRuntime: decision.toRuntime,
  });
  setLaneStatus(lane.id, 'launching', 'system', 'worker_quota_fallback_launching');

  try {
    const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
    const result = await launchRuntimeSurface({
      runtime: decision.toRuntime,
      prompt: input.prompt,
      repoPath: lane.worktreePath ?? lane.repoPath,
      projectRepoPath: lane.repoPath,
      branchName: lane.branch,
      baseBranch: lane.baseBranch,
      model: decision.toModel,
      isolate: false,
      skipSetup: true,
      existingLaneId: lane.id,
      packetId: lane.packetId ?? undefined,
    });
    if (!result.ok || !result.surfaceId) {
      throw new Error(result.note || 'Equivalent runtime launch failed.');
    }

    attachSession(lane.id, result.surfaceId, 'system');
    setLaneStatus(lane.id, 'running', 'system', 'worker_quota_fallback_launched');
    recordLaneEvent(lane.id, 'worker_fallback', 'system', {
      ...payload,
      status: 'redispatched',
      sessionKey: result.surfaceId,
    });
    if (lane.packetId) {
      const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
      patchMissionPacket(lane.packetId, {
        runtime: decision.toRuntime,
        assignedModel: decision.toModel,
        dispatchRuntimePin: decision.toRuntime,
      });
    }
    return {
      handled: true,
      action: 'redispatched',
      toRuntime: decision.toRuntime,
      sessionKey: result.surfaceId,
    };
  } catch (error) {
    const fallbackError = error instanceof Error ? error.message : String(error);
    rebindLaneRuntime(lane.id, lane.runtime, {
      reason: 'cross_house_worker_fallback_failed',
      attemptedRuntime: decision.toRuntime,
    });
    setLaneStatus(lane.id, 'paused', 'system', 'worker_quota_fallback_failed');
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: { ...payload, autoFallbackEnabled: true, fallbackError },
    });
    return { handled: true, action: 'card', toRuntime: decision.toRuntime, inboxId: item.id };
  }
}
