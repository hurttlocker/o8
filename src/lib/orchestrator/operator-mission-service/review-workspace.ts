import path from 'node:path';

import { getApproval, listApprovalsForContext } from '@/lib/approvals/store';
import { assessDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { findLatestLaneByPacket, setLaneStatus } from '@/lib/lane/registry';
import { findActiveReviewTurn } from '@/lib/lane/review-turn-state';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { listRepos } from '@/lib/repos/registry';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { assertNoActiveWorkspaceArtifactRestore } from '@/lib/workspace/artifact-restore-state';
import { assertManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import { assertSnapshotRetentionReleased, assertWorkspaceRetentionReleased } from '@/lib/workspace/retention-holds';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import { getWorkspaceSnapshot } from '@/lib/worktree/snapshot-state';

function failedReviewLane(lane: Lane | null): lane is Lane & { packetId: string; sessionKey: string; worktreePath: string } {
  return Boolean(lane?.packetId && lane.sessionKey && lane.worktreePath
    && lane.status === 'awaiting_orchestrator' && lane.lastEventLabel === 'review_queue_failed'
    && lane.ownership === 'managed' && !lane.outcome && !lane.writerToken);
}

function assertPacketNotHeld(packetId: string) {
  const current = readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId);
  const registered = findMissionRegistryEntryByPacketId(packetId, { includeArchived: true });
  const retained = registered?.mission.packets.find(packet => packet.id === packetId);
  if (registered?.archivedAt || [current, retained].some(packet => packet && (
    packet.queueState === 'held' || packet.holdIntent === 'operator'
    || packet.archivedAt || packet.releaseState === 'released'
  ))) throw new Error('The packet is held, archived, or released.');
}

/** A recorded independent verdict can settle a failed queue without retrying its reviewer. */
export async function reconcileIndependentReviewWorkspace(input: {
  lane: Lane;
  approvalId: string;
  reviewedHeadSha: string;
}): Promise<{ status: 'reviewing' | 'unchanged'; reason: string }> {
  if (!failedReviewLane(input.lane)) return { status: 'unchanged', reason: 'Not a failed review workspace.' };
  const expected = input.lane;
  try {
    return await withPacketLifecycleMutationLock(expected.packetId, async ({ contended }) => {
      if (contended) throw new Error('Another packet lifecycle mutation ran first.');
      const lane = findLatestLaneByPacket(expected.packetId);
      if (!failedReviewLane(lane) || lane.id !== expected.id
        || lane.sessionKey !== expected.sessionKey || lane.worktreePath !== expected.worktreePath
        || lane.repoPath !== expected.repoPath || lane.branch !== expected.branch) {
        throw new Error('The failed review workspace identity changed.');
      }
      assertPacketNotHeld(lane.packetId);
      assertNoActiveWorkspaceArtifactRestore(lane.packetId);
      if (findActiveReviewTurn(lane.id)) throw new Error('A review turn is still active.');
      const repo = (await listRepos()).find(entry => path.resolve(entry.localPath) === path.resolve(lane.repoPath));
      if (!repo || path.resolve(lane.worktreePath) === path.resolve(repo.localPath)) {
        throw new Error('The lane does not own an isolated registered workspace.');
      }
      const snapshot = getWorkspaceSnapshot(repo.id, lane.packetId);
      if (snapshot && (snapshot.state !== 'materialized' || snapshot.laneId !== lane.id
        || path.resolve(snapshot.originalPath) !== path.resolve(lane.worktreePath))) {
        throw new Error('The workspace snapshot is not this materialized lane.');
      }
      const identity = await assertManagedWorkspaceMaterialization(lane.repoPath, lane.worktreePath);
      const assertHolds = () => {
        assertWorkspaceRetentionReleased(lane.worktreePath, identity);
        assertSnapshotRetentionReleased({ repositoryUuid: repo.id, packetId: lane.packetId, originalPath: lane.worktreePath });
      };
      assertHolds();
      const binding = await getOwnedSessionLifecycle(lane.sessionKey)?.getWorkspaceBinding?.(lane.sessionKey);
      if (!binding || binding.sessionState !== 'active' || binding.activeRun
        || binding.binding.packetId !== lane.packetId
        || path.resolve(binding.binding.cwd) !== path.resolve(lane.worktreePath)) {
        throw new Error('The owned session is active or does not bind this workspace.');
      }
      const processes = await probeOwnedSessionProcessQuiescence(lane.sessionKey, lane.worktreePath);
      if (processes.state !== 'quiescent') throw new Error(`Workspace process state is ${processes.state}.`);
      const approval = getApproval(input.approvalId);
      if (approval?.args?.reviewedHeadSha !== input.reviewedHeadSha) throw new Error('The recorded approval HEAD changed.');
      const reviews = () => JSON.stringify(listApprovalsForContext({
        packetId: lane.packetId, laneId: lane.id, sessionKey: lane.sessionKey, projectId: null,
      }));
      const recordedReviews = reviews();
      const assessment = await assessDurableApprovedReview(lane);
      if (!assessment.approved || assessment.approvalId !== input.approvalId) {
        throw new Error(assessment.reason);
      }
      await assertWorktreeMaterializationIdentity(lane.worktreePath, identity);
      const [head, status] = await withWorktreeMaterializationExecution(lane.worktreePath, identity, () => Promise.all([
        materializationAwareExecFile('git', ['rev-parse', 'HEAD'], { cwd: lane.worktreePath }),
        materializationAwareExecFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: lane.worktreePath }),
      ]));
      if (head.stdout.trim() !== input.reviewedHeadSha || status.stdout.trim()
        || reviews() !== recordedReviews) {
        throw new Error('The reviewed source or approval changed during reconciliation.');
      }
      const fresh = findLatestLaneByPacket(lane.packetId);
      if (!failedReviewLane(fresh) || fresh.id !== lane.id || fresh.updatedAt !== lane.updatedAt
        || findActiveReviewTurn(lane.id)) throw new Error('The lane changed during review reconciliation.');
      assertPacketNotHeld(lane.packetId);
      assertHolds();
      setLaneStatus(lane.id, 'reviewing', 'orchestrator', 'independent_review_reconciled', {
        reason: `Completed approval ${input.approvalId} for ${input.reviewedHeadSha}; original review queue failure retained.`,
      });
      return { status: 'reviewing', reason: 'The current independent approval settled the failed review lifecycle.' };
    });
  } catch (error) {
    return { status: 'unchanged', reason: error instanceof Error ? error.message : 'Workspace eligibility could not be proved.' };
  }
}
