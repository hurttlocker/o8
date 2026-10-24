import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Lane } from './types';
import type { MergeCheckResult } from './preview-merge';
import { checkReviewedHeadIntegrity, formatReviewedHeadMismatchNote } from './review-head-integrity';
import { isDependencyMaterializationIncomplete, verifyDependencyMaterialization, DependencyMaterializationIncompleteError } from '@/lib/workspace/dependency-materialization-verification';

/** Read-only assessments used by the worktree merge before publication. */
export async function mergeRuntimePrerequisites(lane: Lane): Promise<MergeCheckResult[]> {
  const cwd = lane.worktreePath || lane.repoPath;
  const head = await checkReviewedHeadIntegrity(lane, cwd);
  const checks: MergeCheckResult[] = [{ name: 'reviewed-head', verdict: head.ok ? 'pass' : 'fail',
    ...(!head.ok ? { detail: formatReviewedHeadMismatchNote(head),
      actions: [`Re-review the current HEAD ${head.currentHeadSha} with o8 packet review ${lane.packetId} --approve --expected-sha ${head.currentHeadSha}, including its required contract evidence.`] } : {}) }];
  const { inspectCliOperationAdmission } = await import('@/lib/setup/cli-operation-admission-shared');
  const admission = inspectCliOperationAdmission();
  checks.push({ name: 'work-admission', verdict: admission.blocked ? 'fail' : 'pass',
    ...(admission.blocked ? { detail: admission.message, actions: ['Wait for the reserved app restart or CLI update to finish, then rerun merge-preview.'] } : {}) });
  if (existsSync(join(cwd, 'package.json'))) {
    const dependencies = await verifyDependencyMaterialization(cwd);
    const incomplete = isDependencyMaterializationIncomplete(dependencies);
    checks.push({ name: 'dependency-materialization', verdict: incomplete ? 'fail' : 'pass',
      detail: incomplete ? new DependencyMaterializationIncompleteError(dependencies, false, null).message : 'Required gate binaries are available.',
      actions: ['Restore the packet workspace dependencies with its declared package manager so the listed gate binaries resolve, then rerun verification.'] });
  }
  return checks;
}
