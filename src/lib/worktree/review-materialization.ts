import { materializationAwareExecFile } from './materialization-execution';
import type { CreateWorktreeOptions, WorktreeInfo } from './types';

/** This mode can only copy a reviewed immutable revision into a managed directory. */
export function assertReviewMaterializationOptions(options: CreateWorktreeOptions): void {
  if (options.agentType !== 'review' || options.managed !== true || options.isolationPreference !== 'git-worktree'
    || !/^[a-f0-9]{40}$/i.test(options.baseBranch || '') || options.packetId || options.laneId) {
    throw new Error('Review materialization requires a managed Git worktree and an immutable commit.');
  }
}

export async function finishReviewMaterialization(info: WorktreeInfo, gitOptions: string[]): Promise<WorktreeInfo> {
  const receipt = await materializationAwareExecFile('git', [...gitOptions, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    windowsHide: true, cwd: info.path, timeout: 5000,
  });
  if (receipt.stdout.trim().toLowerCase() !== info.baseBranch.toLowerCase()) {
    throw new Error('The review workspace does not contain the reviewed commit.');
  }
  const branch = await materializationAwareExecFile('git', [...gitOptions, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    windowsHide: true, cwd: info.path, timeout: 5000,
  });
  if (branch.stdout.trim() !== info.branch) throw new Error('The review workspace branch changed during materialization.');
  return info;
}
