import { resolveCurrentBranch } from './worktree-merge-git';
import { appendEvent } from './registry';
import type { Lane, LaneCommandResult } from './types';

export type MergeBranchResolver = typeof resolveCurrentBranch;

type MergeBranchResult =
  | { ok: true; actualBranch: string }
  | { ok: false; result: LaneCommandResult };

/**
 * Convert the three-state Git probe into a merge decision. Only a documented
 * symbolic-ref refusal proves detachment; inconclusive probes remain visible
 * and retryable without routing a false operator diagnosis.
 */
export async function resolveMergeBranchForLane(input: {
  lane: Pick<Lane, 'id' | 'packetId'>;
  worktreePath: string;
  branchResolver?: MergeBranchResolver;
}): Promise<MergeBranchResult> {
  const resolution = await (input.branchResolver ?? resolveCurrentBranch)(input.worktreePath);
  if (resolution.state === 'attached') {
    return { ok: true, actualBranch: resolution.branch };
  }
  if (resolution.state === 'detached') {
    return {
      ok: false,
      result: {
        ok: false,
        laneId: input.lane.id,
        note: `Cannot merge detached worktree HEAD. ${resolution.evidence}`,
        reason: 'detached_worktree_head',
      },
    };
  }

  appendEvent(input.lane.id, 'update', 'system', {
    event: 'merge_branch_probe_unknown',
    packetId: input.lane.packetId,
    worktreePath: input.worktreePath,
    evidence: resolution.evidence,
  });
  return {
    ok: false,
    result: {
      ok: false,
      laneId: input.lane.id,
      note: `Could not verify the worktree branch. ${resolution.evidence} The worktree was not classified as detached.`,
      reason: 'branch_probe_unknown',
    },
  };
}
