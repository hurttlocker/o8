import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  buildInlineIssuesFromPrompt,
  createMission,
  dispatchMission,
} from '@/lib/orchestrator/operator-mission-service';
import { getOperatorDefaultsSync, resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
import { isSingleSubCheapTierWorker, resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  formatDispatchableRuntimeChoices,
  isDispatchableRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { assertRuntimeDispatchable, DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeRuntime(value: unknown): OrchestratorRuntime | null {
  return isDispatchableRuntime(value) ? value : null;
}

/**
 * Voice / canvas spawn seam — "spawn N agents on <task>" → a gateless worktree
 * mission, created and dispatched in one call so cards bloom on the canvas the
 * instant you ask. The worktree spawn is reversible by construction (a branch
 * that touches nothing), so it carries no approval gate; only the downstream
 * irreversible verbs (merge / push / prod) stay gated.
 *
 * Body: { repoPath, task, count?, runtime?, constraints?, useBrain?, origin? }
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : '';
  if (!repoPath) {
    return operatorError('invalid_request', 'repoPath is required.', 400);
  }

  const task = typeof record.task === 'string' ? record.task.trim() : '';
  if (!task) {
    return operatorError('invalid_request', 'task is required.', 400);
  }

  const requestedRuntimeRaw = record.requestedRuntime ?? record.runtime;
  const requestedModel = record.requestedModel ?? record.model;
  const explicitRuntimeRequested = !(requestedRuntimeRaw === undefined || requestedRuntimeRaw === null || requestedRuntimeRaw === '');
  const requestedRuntime = !explicitRuntimeRequested
    ? resolveDefaultDispatchRuntimeSync()
    : normalizeRuntime(requestedRuntimeRaw);
  if (!requestedRuntime) {
    return operatorError('invalid_request', `runtime must be one of: ${formatDispatchableRuntimeChoices()}.`, 400);
  }
  const defaults = getOperatorDefaultsSync().values;
  const profileRouting = resolveSubscriptionProfileRouting({
    profile: defaults.subscriptionProfile,
    requestedRuntime: explicitRuntimeRequested || defaults.subscriptionProfile === 'both' ? requestedRuntime : null,
    requestedModel: typeof requestedModel === 'string' ? requestedModel : null,
    defaultDispatchModel: defaults.defaultDispatchModel,
  });
  if (!profileRouting.ok) {
    return operatorError(profileRouting.code, profileRouting.message, 400);
  }

  const workerRouting = resolveWorkerRouting({
    workerIntent: record.workerIntent,
    requestedProvider: record.requestedProvider,
    requestedRuntime: profileRouting.requestedRuntime,
    requestedModel: profileRouting.requestedModel,
    source: 'spawn-prompt-api',
  });
  const huddle = typeof record.huddle === 'boolean'
    ? record.huddle
    : isSingleSubCheapTierWorker({
        profile: defaults.subscriptionProfile,
        runtime: workerRouting.selectedRuntime,
        model: workerRouting.selectedModel,
      });
  try {
    await assertRuntimeDispatchable(workerRouting.selectedRuntime);
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
        runtime: error.status.runtime,
        house: error.status.house,
        installed: error.status.installed,
        authenticated: error.status.authenticated,
        unavailableReason: error.status.unavailableReason,
      });
    }
    const message = error instanceof Error ? error.message : 'Runtime readiness check failed.';
    return operatorError('runtime_preflight_failed', message, 500);
  }

  let issues;
  try {
    issues = buildInlineIssuesFromPrompt(task, typeof record.count === 'number' ? record.count : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to build spawn tasks.';
    return operatorError('invalid_request', message, 400);
  }

  try {
    const mission = await createMission({
      issues,
      repoPath,
      runtime: workerRouting.selectedRuntime,
      workerIntent: workerRouting.workerIntent,
      requestedProvider: workerRouting.requestedProvider,
      requestedRuntime: profileRouting.requestedRuntime,
      requestedModel: workerRouting.requestedModel,
      constraints: typeof record.constraints === 'string' ? record.constraints : '',
      ...(typeof record.useBrain === 'boolean' ? { useBrain: record.useBrain } : {}),
      ...(huddle ? { huddle } : {}),
    });

    const dispatch = await dispatchMission({ missionId: mission.missionId });

    const packetIds = mission.packets.map((packet) => packet.id);
    return operatorSuccess({
      ...mission,
      ...dispatch,
      packetIds,
      ...(record.origin === 'symon' ? { origin: 'symon' } : {}),
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to spawn agents.';
    return operatorError('spawn_prompt_failed', message, 500, error);
  }
}
