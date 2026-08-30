import { resolveMergeTestReplayEnabledSync } from '@/lib/operator/defaults';
import type { MergeCheckResult } from './preview-merge';
import { runLaneRebaseLint } from './rebase-lint';
import { runLaneRebaseTests } from './rebase-tests';
import { runLaneRebaseTypecheck } from './rebase-typecheck';

export type LaneRebaseVerifyResult =
  | { ok: true; checks: MergeCheckResult[] }
  | { ok: false; kind: 'typecheck' | 'lint' | 'tests'; output: string; checks: MergeCheckResult[] };

/**
 * The full post-rebase merge gate: typecheck, changed-file lint, then an
 * opt-in test replay against the rebased merged state. Returns a discriminated failure so the
 * caller can route to the layered escalation with the right kind label while
 * sharing the same 1-extra-turn retry budget.
 *
 * Test replay is gated on `mergeTestReplayEnabled` (default off) so existing
 * merges are unchanged until an operator opts in.
 */
export async function runLaneRebaseVerify(input: {
  cwd: string;
  baseRef: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseVerifyResult> {
  const typecheck = await runLaneRebaseTypecheck(input);
  if (!typecheck.ok) {
    return {
      ok: false,
      kind: 'typecheck',
      output: typecheck.output,
      checks: [
        { name: 'typecheck', verdict: 'fail', detail: typecheck.output },
        { name: 'lint', verdict: 'skipped', detail: 'Not run because typecheck failed.' },
      ],
    };
  }
  const checks: MergeCheckResult[] = [{
    name: 'typecheck',
    verdict: typecheck.skipped ? 'skipped' : 'pass',
    ...(typecheck.skipped ? { detail: typecheck.skipped } : {}),
  }];

  const lint = await runLaneRebaseLint(input);
  if (!lint.ok) {
    checks.push({ name: 'lint', verdict: 'fail', detail: lint.output });
    return { ok: false, kind: 'lint', output: lint.output, checks };
  }
  checks.push({
    name: 'lint',
    verdict: lint.skipped ? 'skipped' : 'pass',
    ...(lint.skipped ? { detail: lint.skipped } : lint.detail ? { detail: lint.detail } : {}),
  });

  if (!mergeTestReplayEnabled()) {
    return { ok: true, checks };
  }

  const tests = await runLaneRebaseTests(input);
  if (!tests.ok) {
    return { ok: false, kind: 'tests', output: tests.output, checks };
  }

  return { ok: true, checks };
}

function mergeTestReplayEnabled(): boolean {
  try {
    return resolveMergeTestReplayEnabledSync();
  } catch {
    // Never let a settings read failure change merge behavior — default off.
    return false;
  }
}
