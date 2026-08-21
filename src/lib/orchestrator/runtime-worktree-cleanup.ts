import type { LaneRuntime } from '@/lib/lane/types';
import { releaseOpenCodeWorkspace, type OpenCodeWorkspaceReleaseResult } from '@/lib/opencode/service-lifecycle';
import { listWorktreeHolderPids } from '@/lib/worktree/holder-diagnostics';

export interface RuntimeWorktreeCleanupResult<T> {
  result: T;
  attempts: 1 | 2;
  holderPids: number[];
  releaseAttempts: OpenCodeWorkspaceReleaseResult[];
}

/**
 * Release runtime-owned workspace state before cleanup. OpenCode gets one
 * bounded retry because its shared service may release file watches slightly
 * after acknowledging location eviction.
 */
export async function runRuntimeAwareWorktreeCleanup<T>(input: {
  runtime: LaneRuntime;
  worktreePath: string | null;
  cleanup: () => Promise<T>;
  removed: (result: T) => boolean;
}): Promise<RuntimeWorktreeCleanupResult<T>> {
  const worktreePath = input.worktreePath?.trim() || null;
  const releaseAttempts: OpenCodeWorkspaceReleaseResult[] = [];
  if (input.runtime === 'opencode' && worktreePath) {
    releaseAttempts.push(await releaseOpenCodeWorkspace(worktreePath));
  }

  let result = await input.cleanup();
  if (input.removed(result) || input.runtime !== 'opencode' || !worktreePath) {
    return { result, attempts: 1, holderPids: [], releaseAttempts };
  }

  releaseAttempts.push(await releaseOpenCodeWorkspace(worktreePath));
  result = await input.cleanup();
  const holderPids = input.removed(result) ? [] : await listWorktreeHolderPids(worktreePath);
  return { result, attempts: 2, holderPids, releaseAttempts };
}
