import { realpath } from 'node:fs/promises';
import { getLane } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { findActiveReviewTurn } from '@/lib/lane/review-turn-state';
import { inspectPacketManagedRunAdmission, packetSteerHoldReason } from '@/lib/lane/packet-stop-hold';

/** Called only for operator-owned reviewer processes, never packet worker credentials. */
export async function admitsReviewerManagedRun(packetId: string, laneId: string | null | undefined, cwd: string): Promise<boolean> {
  const lane = laneId ? getLane(laneId) : null;
  const turn = lane ? findActiveReviewTurn(lane.id) : null;
  if (!lane || lane.packetId !== packetId || !lane.worktreePath || lane.status !== 'reviewing'
    || !turn?.expectedHeadSha || !['auto-review', 'merge-gate-review'].includes(turn.surface ?? '')) return false;
  try {
    if (await realpath(cwd) !== await realpath(lane.worktreePath)
      || await readHeadSha(lane.worktreePath, lane.repoPath) !== turn.expectedHeadSha) return false;
  } catch {
    return false;
  }
  // Filesystem checks yield. Re-read stop/turn authority immediately before registration.
  const admission = inspectPacketManagedRunAdmission(packetId);
  return admission.reason === 'packet_terminal' && admission.status === 'awaiting_review'
    && !packetSteerHoldReason(packetId) && getLane(lane.id)?.status === 'reviewing'
    && findActiveReviewTurn(lane.id)?.id === turn.id;
}
