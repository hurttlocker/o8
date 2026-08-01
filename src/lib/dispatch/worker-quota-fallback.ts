import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
} from '@/lib/orchestrator/cross-house-policy';
import { resolveCrossHouseWorkerFallbackSync, getOperatorDefaultsSync } from '@/lib/operator/defaults';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';

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

function activeFallbackAttemptForFailure(
  laneId: string,
  runtime: string,
  surfaceId: string,
): { attemptId: string; kind: 'candidate_exhausted' | 'source_duplicate'; sessionKey?: string } | null {
  const rows = getSqlite().prepare(`
    SELECT verb, payload_json
    FROM lane_events
    WHERE lane_id = ? AND verb IN ('worker_fallback', 'worker_fallback_terminal')
    ORDER BY rowid DESC
  `).all(laneId) as Array<{ verb: string; payload_json: string }>;
  const terminal = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const attemptId = typeof payload.attemptId === 'string' ? payload.attemptId : null;
    if (!attemptId) continue;
    if (row.verb === 'worker_fallback_terminal') {
      terminal.add(attemptId);
      continue;
    }
    if (row.verb !== 'worker_fallback' || terminal.has(attemptId) || seen.has(attemptId)) continue;
    seen.add(attemptId);
    if (payload.toRuntime === runtime) {
      if (payload.status === 'launching') return { attemptId, kind: 'candidate_exhausted' };
      if (payload.status === 'redispatched' && payload.sessionKey === surfaceId) {
        return { attemptId, kind: 'candidate_exhausted', sessionKey: surfaceId };
      }
    }
    if (payload.fromRuntime === runtime && payload.surfaceId === surfaceId) {
      return {
        attemptId,
        kind: 'source_duplicate',
        ...(typeof payload.sessionKey === 'string' ? { sessionKey: payload.sessionKey } : {}),
      };
    }
  }
  return null;
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

  const [{ getLane, setLaneStatus, attachSession }, { recordLaneEvent }, { rebindLaneRuntime }] = await Promise.all([
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

  const activeFallbackAttempt = activeFallbackAttemptForFailure(
    lane.id,
    input.runtime,
    input.surfaceId,
  );
  if (activeFallbackAttempt?.kind === 'source_duplicate') {
    return {
      handled: true,
      action: 'redispatched',
      toRuntime: decision.toRuntime,
      sessionKey: activeFallbackAttempt.sessionKey,
    };
  }
  if (activeFallbackAttempt?.kind === 'candidate_exhausted') {
    const terminalPayload = {
      ...payload,
      attemptId: activeFallbackAttempt.attemptId,
      suggestedRuntime: null,
      suggestedModel: null,
      status: 'both_houses_exhausted',
      bothHousesExhausted: true,
      note: 'Both comparable subscription houses are exhausted. Worker dispatch is paused for human action.',
    };
    recordLaneEvent(lane.id, 'worker_fallback_terminal', 'system', {
      ...terminalPayload,
    });
    setLaneStatus(lane.id, 'paused', 'system', 'worker_cross_house_fallback_exhausted');
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        ...terminalPayload,
        autoFallbackEnabled: resolveCrossHouseWorkerFallbackSync(),
      },
    });
    return { handled: true, action: 'card', inboxId: item.id };
  }

  const autoFallback = resolveCrossHouseWorkerFallbackSync()
    && decision.action === 'handoff';

  if (!autoFallback) {
    const item = enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        ...payload,
        fallbackAlreadyTried: false,
        autoFallbackEnabled: resolveCrossHouseWorkerFallbackSync(),
      },
    });
    return { handled: true, action: 'card', toRuntime: decision.toRuntime, inboxId: item.id };
  }

  const attemptId = `worker-fallback-${randomUUID()}`;
  recordLaneEvent(lane.id, 'worker_fallback', 'system', {
    ...payload,
    attemptId,
    toRuntime: decision.toRuntime,
    status: 'launching',
  });
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
      attemptId,
      toRuntime: decision.toRuntime,
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
    recordLaneEvent(lane.id, 'worker_fallback_terminal', 'system', {
      ...payload,
      attemptId,
      toRuntime: decision.toRuntime,
      status: 'launch_failed',
      fallbackError,
    });
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
