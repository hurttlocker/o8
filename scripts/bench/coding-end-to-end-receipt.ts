import { execFileSync } from 'node:child_process';

import { resolveRequireApprovalSync } from '../../src/lib/operator/defaults';
import { END_TO_END_CONDITIONS, type EndToEndTask } from './coding-end-to-end';
import { countArmOutcomes } from './coding-arm-outcome';
import { GOVERNED_EXISTING_BRANCH_POLICY } from './coding-governed-mission';
import { abortedRunControl, type O8BackendAbortError } from './coding-run-control';
import type { EndToEndCollectionReceipt } from './run-coding-end-to-end';

export function createAbortedEndToEndCollection(
  repoRoot: string,
  runId: string,
  tasks: EndToEndTask[],
  error: O8BackendAbortError,
): EndToEndCollectionReceipt {
  return {
    schema: 'o8/coding-end-to-end-collection/v1',
    runId,
    createdAt: new Date().toISOString(),
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    approvalMode: resolveRequireApprovalSync(),
    governedExistingBranchPolicy: GOVERNED_EXISTING_BRANCH_POLICY,
    conditions: [...END_TO_END_CONDITIONS],
    tasks: tasks.map((task) => ({ ...task })),
    arms: [],
    outcomeTotals: countArmOutcomes([]),
    runControl: abortedRunControl(error),
  };
}
