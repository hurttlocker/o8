import type { Lane, LaneEventActor } from '@/lib/lane/types';
import { appendEvent } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { submitPacketReview } from './review';
import { compareCommitPatchIds } from './merge-truth';

function carriedDirectiveViolations(input: OrchestratorPacket) {
  return input.review?.directivesViolated?.map((violation) => ({
    ...violation,
    file: violation.file ?? undefined,
    snippet: violation.snippet ?? undefined,
  }));
}

export async function carryReviewAcrossRebaseIfSamePatch(input: {
  packet: OrchestratorPacket;
  lane: Lane;
  reviewedHeadSha: string;
  currentHeadSha: string;
  actor: LaneEventActor;
}) {
  const comparison = await compareCommitPatchIds(
    input.lane.worktreePath || input.lane.repoPath,
    input.reviewedHeadSha,
    input.currentHeadSha,
    input.lane.baseBranch || 'main',
  );
  if (!comparison.matches || !comparison.patchId) return false;

  await submitPacketReview({
    packetId: input.packet.id,
    findings: [],
    approved: true,
    reviewedHeadSha: input.currentHeadSha,
    directivesApplied: input.packet.review?.directivesApplied,
    directivesViolated: carriedDirectiveViolations(input.packet),
  });
  appendEvent(input.lane.id, 'review_carried_across_rebase', input.actor, {
    from: input.reviewedHeadSha,
    to: input.currentHeadSha,
    patchId: comparison.patchId,
    packetId: input.packet.id,
  });
  return true;
}
