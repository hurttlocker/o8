import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import {
  withResourceLease,
  type ResourceLeaseGuardRefusal,
  type ResourceLeaseGuardResult,
} from '@/lib/leases/resource-lease-guard';
import { setLaneStatus } from '@/lib/lane/registry';
import type { LaneCommandResult } from '@/lib/lane/types';

/**
 * Serialize Git publication actions per repository. The lock is also the
 * linearization boundary for final spoken-review governance verification.
 */
const repoActionChains = new Map<string, Promise<unknown>>();
export const REPO_ACTION_LEASE_MAX_WAIT_MS = 5_000;

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
