import { chainOnKey } from '@/lib/util/keyed-promise-chain';

/**
 * Serialize Git publication actions per repository. The lock is also the
 * linearization boundary for final spoken-review governance verification.
 */
const repoActionChains = new Map<string, Promise<unknown>>();

export function withRepoActionLock<T>(
  repoPath: string,
  action: () => Promise<T>,
): Promise<T> {
  return chainOnKey(repoActionChains, repoPath, action);
}
