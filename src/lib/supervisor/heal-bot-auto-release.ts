import { hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { findLaneByPacket, getLane, setLaneStatus } from '@/lib/lane/registry';
import { probeBranchMerged } from '@/lib/orchestrator/branch-merge-probe';
import { readOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';

const AUTO_RELEASE_PROBE_RETRY_MS = 60_000;
const AUTO_RELEASE_MIN_EVENT_AGE_MS = 30_000;
const autoReleaseProbeLastByRepoPacket = new Map<string, number>();

function recentEventWithinWindow(values: Array<string | null | undefined>, now: number): boolean {
  const latest = values.reduce((current, value) => {
    if (!value) return current;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(current, timestamp) : current;
  }, 0);
  return latest > 0 && now - latest < AUTO_RELEASE_MIN_EVENT_AGE_MS;
}

export async function runAwaitingReviewAutoReleaseSweep(): Promise<void> {
  const state = readOrchestratorControlPlaneState();
  const now = Date.now();

  for (const packet of state.packets) {
    if (packet.status !== 'awaiting_review' || packet.releaseState === 'released') continue;
    const lane = (packet.lane?.laneId ? getLane(packet.lane.laneId) : null) ?? findLaneByPacket(packet.id);
    if (!lane?.repoPath || lane.status === 'archived' || lane.status === 'merging') continue;
    if (recentEventWithinWindow([packet.lastEventAt, lane.lastEventAt], now)) continue;

    const throttleKey = `${lane.repoPath}\0${packet.id}`;
    const lastProbeMs = autoReleaseProbeLastByRepoPacket.get(throttleKey) ?? 0;
    if (now - lastProbeMs < AUTO_RELEASE_PROBE_RETRY_MS) continue;
    autoReleaseProbeLastByRepoPacket.set(throttleKey, now);

    const worktreePath = lane.worktreePath?.trim();
    const probeRepoPath = worktreePath || lane.repoPath;
    const branch = worktreePath ? 'HEAD' : lane.branch || 'HEAD';
    const displayBranch = lane.branch || branch;
    const base = lane.baseBranch || 'main';

    try {
      const probe = await probeBranchMerged({ repoPath: probeRepoPath, branch, base });
      if (!probe.merged) continue;
      if (!(await hasDurableApprovedReview(lane))) {
        console.warn(
          `[heal-bot] Refusing plain auto-release for packet ${packet.referenceLabel}: merged branch ${displayBranch} has no durable approved review.`,
        );
        continue;
      }

      const releasedAt = new Date().toISOString();
      if (lane.status !== 'completed') setLaneStatus(lane.id, 'completed', 'system', 'merged');
      const { result: released } = await withLockedState((current) => {
        const packetState = current.packets.find((candidate) => candidate.id === packet.id);
        if (!packetState || packetState.releaseState === 'released' || packetState.status !== 'awaiting_review') return false;

        markPacketReleased(packetState, {
          source: 'heal_bot_auto_release',
          mergeCommit: probe.mergeCommit,
          evidenceKind: 'branch_merged_probe',
          releasedAt,
        });
        packetState.lastEventAt = releasedAt;
        packetState.lastEventLabel = 'auto_released';
        if (packetState.lane) {
          packetState.lane.lastEventAt = releasedAt;
          packetState.lane.lastEventLabel = 'merged';
        }
        current.updatedAt = releasedAt;
        return true;
      });

      if (released) {
        console.log(`[heal-bot] auto-released packet ${packet.referenceLabel} on ${displayBranch} at ${probe.mergeCommit ?? 'unknown'}`);
      }
    } catch (error) {
      console.warn(
        `[heal-bot] Auto-release probe failed for packet ${packet.referenceLabel} on ${displayBranch}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
