import type { GitHubPullRequestSnapshot } from '@/lib/github-broker/store';
import { getLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withLockedState } from './control-plane';
import { findMissionRegistryEntryByPacketId, withMissionRegistryState } from './mission-registry';
import { markPacketReleased } from './packet-release-truth';
import type { OrchestratorPacket } from './types';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent, verifyCurrentLaneHead } from './release-ownership';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export function canApplyAutomaticRelease(packet: OrchestratorPacket, lane: Lane, generation: string, allowReleased = false): boolean {
  if (['launching', 'running', 'recovering', 'queued'].includes(packet.status)) return false;
  if (!['reviewing', 'completed', 'archived'].includes(lane.status)) return false;
  if (lane.packetId !== packet.id) return false;
  return packetReleaseIdentityIsCurrent(packet, lane.id, generation, allowReleased);
}

async function matchesMergedPull(lane: Lane, pull: GitHubPullRequestSnapshot): Promise<boolean> {
  if (!pull.mergedAt || !SHA.test(pull.headSha ?? '') || !SHA.test(pull.mergeCommit ?? '')) return false;
  if (pull.baseRefName !== lane.baseBranch || pull.headRefName !== lane.branch) return false;
  return verifyCurrentLaneHead(lane, pull.headSha!);
}

/** Persist the PR's commit proof before archiving, never enqueue an unproved packet ID. */
export async function releaseMergedPullRequestPacket(
  lane: Lane,
  pull: GitHubPullRequestSnapshot,
  onReleased?: () => void,
): Promise<'released' | 'held' | 'unbound'> {
  const sameLane = (fresh: Lane | null) => fresh && fresh.branch === lane.branch
    && fresh.worktreePath === lane.worktreePath && fresh.repoPath === lane.repoPath
    && fresh.baseBranch === lane.baseBranch && fresh.packetId === lane.packetId;
  const unbound = () => {
    const fresh = getLane(lane.id);
    if (!sameLane(fresh) || fresh?.status !== 'reviewing') return 'held' as const;
    onReleased?.();
    return 'unbound' as const;
  };
  if (!lane.packetId) return unbound();
  const packetId = lane.packetId;
  const currentPacket = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
  const entry = !currentPacket ? findMissionRegistryEntryByPacketId(packetId, { includeArchived: true }) : null;
  const snapshot = currentPacket ?? entry?.mission.packets.find((packet) => packet.id === packetId);
  if (!snapshot) return unbound();
  const generation = packetReleaseGeneration(snapshot, lane.id);
  const apply = async (packet: OrchestratorPacket | undefined): Promise<boolean> => {
    const freshLane = getLane(lane.id);
    if (!packet || !freshLane || !sameLane(freshLane) || !canApplyAutomaticRelease(packet, freshLane, generation, true)) return false;
    if (packet.releaseState === 'released' && (packet.releaseStatePayload?.headSha !== pull.headSha
      || packet.releaseStatePayload?.mergeCommit !== pull.mergeCommit)) return false;
    if (!(await matchesMergedPull(freshLane, pull))) return false;
    const finalLane = getLane(lane.id);
    if (!finalLane || !sameLane(finalLane) || !canApplyAutomaticRelease(packet, finalLane, generation, true)) return false;
    markPacketReleased(packet, { source: 'headless_released', evidenceKind: 'pull_request_merged',
      mergeCommit: pull.mergeCommit, headSha: pull.headSha, releasedAt: pull.mergedAt! });
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = 'pr_merged_reconciled';
    // Archive in this same critical section. A reset or Stop must not interleave
    // between checking packet ownership and retiring its lane.
    onReleased?.();
    return true;
  };
  if (currentPacket) {
    const { result } = await withLockedState((state) => apply(state.packets.find((packet) => packet.id === packetId)));
    return result ? 'released' : 'held';
  }
  const { result } = await withMissionRegistryState(entry!.id, async (state) => ({
    state, result: await apply(state.packets.find((packet) => packet.id === packetId)),
  }));
  return result ? 'released' : 'held';
}
