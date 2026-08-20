import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { withResourceLease } from '@/lib/leases/resource-lease-service';

/**
 * Serialize Git publication actions per repository. The lock is also the
 * linearization boundary for final spoken-review governance verification.
 */
const repoActionChains = new Map<string, Promise<unknown>>();

export function withRepoActionLock<T>(
  repoPath: string,
  action: () => Promise<T>,
): Promise<T> {
  return chainOnKey(repoActionChains, repoPath, () => withResourceLease({
    resource: `repo-tree:${repoPath}`,
    owner: {
      id: `repo-action:${process.pid}`,
      label: `repo-action:${process.pid}`,
      pid: process.pid,
    },
  }, action));
}
