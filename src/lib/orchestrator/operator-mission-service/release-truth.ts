import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { MergePacketResult } from './types';

interface ReleaseLane {
  repoPath: string;
  branch?: string | null;
}

const loadControlPlane = () => import('@/lib/orchestrator/control-plane');
const loadMergeTruth = () => import('./merge-truth');

export function buildAlreadyReleasedResult(mergeSha: string): MergePacketResult {
  return {
    merged: true,
    note: 'Already released (via auto-merge)',
    alreadyReleased: true,
    mergeSha,
    ancestryVerified: true,
  };
}

function isAlreadyReleasedPacket(packet: OrchestratorPacket | null | undefined) {
  return packet?.releaseState === 'released' || packet?.status === 'released';
}

function recordedMergeSha(packet: OrchestratorPacket | null | undefined) {
  return packet?.releaseStatePayload?.mergeCommit?.trim() || null;
}

async function clearStaleReleaseClaim(packetId: string, reason: string) {
  const { withLockedState } = await loadControlPlane();
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet || !isAlreadyReleasedPacket(packet)) return;
    packet.releaseState = 'pending';
    if (packet.status === 'released') packet.status = 'awaiting_review';
    packet.releaseStatePayload = { ...(packet.releaseStatePayload ?? {}), source: reason };
  });
}

export async function alreadyReleasedResultForPacket(
  packet: OrchestratorPacket | null | undefined,
  lane: ReleaseLane | null | undefined,
): Promise<MergePacketResult | null> {
  if (!isAlreadyReleasedPacket(packet)) return null;
  const mergeSha = recordedMergeSha(packet);
  if (mergeSha && lane?.repoPath) {
    const { isAncestorCommit } = await loadMergeTruth();
    if (await isAncestorCommit(lane.repoPath, mergeSha, 'HEAD')) {
      // A no-change reconciliation can record the base as its merge SHA. The
      // branch must also be on HEAD before that recorded release is trusted.
      if (lane.branch && !(await isAncestorCommit(lane.repoPath, lane.branch, 'HEAD'))) {
        console.error('[merge-truth] released packet branch advanced past its recorded merge', {
          packetId: packet?.id,
          branch: lane.branch,
          mergeSha,
          repoPath: lane.repoPath,
        });
        if (packet?.id) await clearStaleReleaseClaim(packet.id, 'stale_release_flag_branch_advanced');
        return null;
      }
      return buildAlreadyReleasedResult(mergeSha);
    }
    console.error('[merge-truth] stale released packet flag; merge SHA is not on main ancestry', {
      packetId: packet?.id,
      mergeSha,
      repoPath: lane.repoPath,
    });
    await clearStaleReleaseClaim(packet!.id, 'stale_release_flag_ancestry_failed');
    return null;
  }
  console.error('[merge-truth] stale released packet flag; no merge SHA available for ancestry verification', {
    packetId: packet?.id,
    repoPath: lane?.repoPath ?? null,
  });
  if (packet?.id) await clearStaleReleaseClaim(packet.id, 'stale_release_flag_missing_merge_sha');
  return null;
}
