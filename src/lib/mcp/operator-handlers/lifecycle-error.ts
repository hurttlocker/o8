import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import { McpInputError, O8ApiError, safeErrorText } from '@/lib/mcp/api-error';
import { CorrelatedActionUnsettledError } from '@/lib/orchestrator/action-receipt';
import { ControlPlaneLockTimeoutError, readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { TaskMutationError } from '@/lib/tasks/actions';
import { jsonResult } from './shared';

type LifecycleTool = 'o8_task_dispatch' | 'steer_packet' | 'retry_packet' | 'reset_packet';

/** Failure diagnostics never acquire the mutation lock or reconcile/write state. */
function observedState(id: string) {
  try {
    const current = readOrchestratorControlPlaneState();
    const owner = current.packets.some(packet => packet.id === id)
      ? current
      : findMissionRegistryEntryByPacketId(id, { includeArchived: true })?.mission;
    const packet = owner?.packets.find(candidate => candidate.id === id);
    const lane = findLaneByPacket(id) ?? getLane(id);
    return {
      packetId: packet?.id ?? lane?.packetId ?? id,
      missionId: owner?.missionId ?? null,
      state: lane?.status ?? packet?.status ?? 'not_found',
      packetState: packet?.status ?? null,
    };
  } catch {
    return { packetId: id, missionId: null, state: 'unknown', packetState: null };
  }
}

export function lifecycleErrorResult(tool: LifecycleTool, error: unknown, id: unknown) {
  const observed = observedState(typeof id === 'string' ? id.trim() : '');
  const route = error instanceof O8ApiError ? error.routeError : null;
  const resultCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = error instanceof McpInputError ? 'invalid_request'
    : error instanceof ControlPlaneLockTimeoutError ? 'mission_store_busy'
    : error instanceof CorrelatedActionUnsettledError ? 'outcome_unknown'
    : route?.code
      ?? (typeof resultCode === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(resultCode) ? resultCode : null)
      ?? (error instanceof TaskMutationError
        ? error.status === 404 ? 'task_not_found' : error.status === 409 ? 'task_dispatch_conflict' : 'invalid_request'
        : `${tool}_failed`);
  const message = code === 'mission_store_busy'
    ? 'Mission store is busy; inspect current state and wait before retrying.'
    : code === 'outcome_unknown'
      ? 'The prior action may still be running. Inspect its state before sending another mutation.'
      : error instanceof TaskMutationError ? safeErrorText({ error: error.message }) : safeErrorText(error);
  let next = `get_mission_status(${JSON.stringify(observed.missionId ? { missionId: observed.missionId } : {})}) and inspect the packet before taking another action.`;
  if (code === 'invalid_request') next = `Correct the arguments for ${tool} and call it again.`;
  if ((code === 'steer_unavailable' && ['failed', 'archived', 'recovering', 'session_lost'].includes(observed.state))
    || (code === 'task_dispatch_conflict' && !['launching', 'running'].includes(observed.state))) {
    next = `Inspect the packet, then retry_packet(${JSON.stringify({ packetId: observed.packetId })}) to preserve its work before redispatching.`;
  }
  const failure = {
    ok: false,
    code,
    message,
    error: `Failed to ${tool === 'o8_task_dispatch' ? 'dispatch task' : tool === 'steer_packet' ? 'steer packet' : 'reset packet'}: ${message}`,
    ...observed,
    next,
    ...(code === 'mission_store_busy' ? { retryAfterMs: 1000 } : {}),
  };
  console.error('[mcp-operator] lifecycle failure', failure);
  return jsonResult(failure, true);
}
