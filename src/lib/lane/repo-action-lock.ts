import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import {
  withResourceLease,
  type ResourceLeaseGuardRefusal,
  type ResourceLeaseGuardResult,
} from '@/lib/leases/resource-lease-guard';
import {
  appendEvent,
  countLaneEventsByVerbSinceLastLaunch,
  setLaneStatus,
} from '@/lib/lane/registry';
import type { LaneCommandResult } from '@/lib/lane/types';

/**
 * Serialize Git publication actions per repository. The lock is also the
 * linearization boundary for final spoken-review governance verification.
 */
const repoActionChains = new Map<string, Promise<unknown>>();
export const REPO_ACTION_LEASE_MAX_WAIT_MS = 120_000;
const REPO_ACTION_LEASE_AUTO_RETRY_LIMIT = 1;

export function withRepoActionLock<T>(
  repoPath: string,
  action: () => Promise<T>,
  options: { maxWaitMs?: number } = {},
): Promise<ResourceLeaseGuardResult<T>> {
  return chainOnKey(repoActionChains, repoPath, () => withResourceLease({
    resource: `repo-tree:${repoPath}`,
    owner: {
      id: `repo-action:${process.pid}`,
      label: `repo-action:${process.pid}`,
      pid: process.pid,
    },
    actor: 'system:repo-action',
    maxWaitMs: options.maxWaitMs ?? REPO_ACTION_LEASE_MAX_WAIT_MS,
  }, action));
}

export function repoActionLeaseRefusalResult(
  laneId: string,
  refusal: ResourceLeaseGuardRefusal,
): LaneCommandResult {
  const reason = refusal.code === 'resource_lease_wait_timeout'
    ? 'repo_action_lease_wait_timeout'
    : 'repo_action_lease_unavailable';
  setLaneStatus(laneId, 'reviewing', 'system', reason);
  return {
    ok: false,
    laneId,
    reason,
    note: refusal.message,
  };
}

async function readPacketLeaseWaitRetries(packetId: string | null): Promise<number | null> {
  if (!packetId) return null;
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    return packet ? (packet.leaseWaitAutoRetries ?? 0) : null;
  } catch {
    return null;
  }
}

async function persistPacketLeaseWaitRetry(packetId: string | null, retryCount: number): Promise<void> {
  if (!packetId) return;
  try {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((current) => {
      const packet = current.packets.find((candidate) => candidate.id === packetId);
      if (packet) packet.leaseWaitAutoRetries = Math.max(packet.leaseWaitAutoRetries ?? 0, retryCount);
    });
  } catch (error) {
    console.warn(
      `[repo-action-lock] Could not persist lease-wait retry budget for packet ${packetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function appendLeaseWaitTimeoutEvent(
  laneId: string,
  refusal: ResourceLeaseGuardRefusal,
  retryCount: number,
  willRetry: boolean,
): void {
  appendEvent(laneId, 'lease_wait_timeout', 'system', {
    resource: refusal.resource,
    waitedMs: refusal.waitedMs,
    holder: refusal.holder ? {
      leaseId: refusal.holder.leaseId,
      owner: refusal.holder.owner,
      overdue: refusal.holder.overdue,
    } : null,
    retryCount,
    willRetry,
  });
}

/**
 * Run a lane publication action behind the cross-process repo-tree lease.
 * A timeout happens before the action starts, so one crash-safe retry is safe.
 */
export async function withRepoActionRecovery(
  repoPath: string,
  input: {
    laneId: string;
    packetId: string | null;
    maxWaitMs?: number;
  },
  action: () => Promise<LaneCommandResult>,
): Promise<LaneCommandResult> {
  const eventRetryCount = countLaneEventsByVerbSinceLastLaunch(input.laneId, 'lease_wait_timeout');
  const packetRetryCount = await readPacketLeaseWaitRetries(input.packetId);
  let retryCount = Math.max(eventRetryCount, packetRetryCount ?? 0);

  while (true) {
    const guarded = await withRepoActionLock(repoPath, action, { maxWaitMs: input.maxWaitMs });
    if (guarded.state === 'completed') return guarded.value;
    if (guarded.refusal.code !== 'resource_lease_wait_timeout') {
      return repoActionLeaseRefusalResult(input.laneId, guarded.refusal);
    }

    const willRetry = retryCount < REPO_ACTION_LEASE_AUTO_RETRY_LIMIT;
    appendLeaseWaitTimeoutEvent(input.laneId, guarded.refusal, retryCount, willRetry);
    if (!willRetry) {
      setLaneStatus(input.laneId, 'awaiting_orchestrator', 'system', 'repo_action_lease_wait_timeout');
      return {
        ok: false,
        laneId: input.laneId,
        reason: 'repo_action_lease_wait_timeout',
        note: guarded.refusal.message,
      };
    }

    retryCount += 1;
    await persistPacketLeaseWaitRetry(input.packetId, retryCount);
    setLaneStatus(input.laneId, 'recovering', 'system', 'lease_wait_retry');
  }
}
