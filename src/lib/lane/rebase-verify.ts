import { resolveMergeTestReplayEnabledSync } from '@/lib/operator/defaults';
import { runLaneRebaseTests } from './rebase-tests';
import { runLaneRebaseTypecheck } from './rebase-typecheck';

export type LaneRebaseVerifyResult =
  | { ok: true }
  | { ok: false; kind: 'typecheck' | 'tests'; output: string };

/**
 * The full post-rebase merge gate: typecheck first, then (opt-in) a test replay
 * against the rebased merged state. Returns a discriminated failure so the
 * caller can route to the layered escalation with the right kind label while
 * sharing the same 1-extra-turn retry budget.
 *
 * Test replay is gated on `mergeTestReplayEnabled` (default off) so existing
 * merges are unchanged until an operator opts in.
 */
export async function runLaneRebaseVerify(input: {
  cwd: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseVerifyResult> {
  const typecheck = await runLaneRebaseTypecheck(input);
  if (!typecheck.ok) {
    return { ok: false, kind: 'typecheck', output: typecheck.output };
  }

  if (!mergeTestReplayEnabled()) {
    return { ok: true };
  }

  const tests = await runLaneRebaseTests(input);
  if (!tests.ok) {
    return { ok: false, kind: 'tests', output: tests.output };
  }

  return { ok: true };
}

function mergeTestReplayEnabled(): boolean {
  try {
    return resolveMergeTestReplayEnabledSync();
  } catch {
    // Never let a settings read failure change merge behavior — default off.
    return false;
  }
}
