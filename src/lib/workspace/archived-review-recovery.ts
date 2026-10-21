import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { listApprovalsForContext } from '@/lib/approvals/store';
import { appendEvent, findLatestLaneByPacket, getLaneEvents, updateLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { readOrchestratorControlPlaneState, withControlPlaneLock, writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { packetReleaseGeneration } from '@/lib/orchestrator/release-ownership';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session/types';
import { assertArchivedWorkspaceSessionRestorable } from '@/lib/runtimes/shared/owned-session/archive';
import { getWorkspaceSnapshot, type WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';
import { assertNoActiveWorkspaceArtifactRestore } from './artifact-restore-state';
import { assertSnapshotRetentionReleased } from './retention-holds';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// The normalizer recomputes routing.decidedAt on every read; it is not durable intent.
const packetFingerprint = (packet: OrchestratorPacket) => fingerprint({ ...packet,
  workerRouting: packet.workerRouting ? { ...packet.workerRouting, decidedAt: undefined } : packet.workerRouting,
});
const approvalsFor = (packetId: string) => listApprovalsForContext({ packetId })
  .filter((approval) => approval.toolName === 'orchestrator_review');
const laneProof = (lane: Lane) => fingerprint([lane, getLaneEvents(lane.id, 10_000)]);

export interface ArchivedReviewRecovery {
  snapshot: WorkspaceSnapshotRecord;
  lane: Lane;
  laneProof: string;
  approvalProof: string;
  approvalId: string;
  missionId: string;
  packetProof: string;
  packetGeneration: string;
  binding: OwnedWorkspaceBindingReceipt;
}

/** Only the exact old automatic-archive sequence grants this recovery path. */
export async function prepareArchivedReviewRecovery(
  lane: Lane, snapshot: WorkspaceSnapshotRecord,
): Promise<ArchivedReviewRecovery> {
  if (lane.status !== 'archived' || lane.ownership !== 'managed' || lane.outcome !== 'no_changes'
    || lane.packetId !== snapshot.packetId || lane.id !== snapshot.laneId
    || lane.branch !== snapshot.branch || lane.worktreePath !== null || !lane.sessionKey
    || snapshot.state !== 'parked' || lane.lastEventLabel !== 'archived') {
    throw new Error('Archived lane is not an exact parked automatic-archive candidate.');
  }
  assertNoActiveWorkspaceArtifactRestore(snapshot.packetId, snapshot.originalPath);
  assertSnapshotRetentionReleased(snapshot);
  const events = getLaneEvents(lane.id, 10_000);
  const tail = events.filter((event) => Date.parse(event.timestamp) >= snapshot.stateEnteredAt);
  const [archived, annotated, reason, settled] = tail;
  if (tail.length !== 4 || tail.some((event) => event.actor !== 'system')
    || archived?.verb !== 'status_change' || archived.payload.status !== 'archived'
    || annotated?.verb !== 'update' || annotated.payload.lastEventLabel !== 'finished_no_changes'
    || reason?.verb !== 'status_change' || reason.payload.reason !== 'branch_missing_reconciled'
    || reason.payload.outcome !== 'no_changes' || reason.payload.branch !== snapshot.branch
    || reason.payload.baseSha !== snapshot.baseCommit || reason.payload.repoPath !== lane.repoPath
    || settled?.verb !== 'update' || settled.payload.lastEventLabel !== 'archived') {
    throw new Error('Automatic archive provenance is ambiguous or newer intent exists.');
  }
  const priorStatus = events.filter((event) => Date.parse(event.timestamp) < snapshot.stateEnteredAt
    && event.verb === 'status_change' && typeof event.payload.status === 'string').at(-1);
  if (priorStatus?.payload.status !== 'reviewing') throw new Error('The parked lane was not awaiting review.');
  const approvals = approvalsFor(snapshot.packetId);
  const approval = [...approvals].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!approval || approval.status !== 'approved' || approval.args?.approved !== true
    || approval.metadata?.Lane !== lane.id || approval.sessionKey !== lane.sessionKey
    || approval.args?.reviewSuperseded === true || approval.args?.reviewedHeadSha !== snapshot.headCommit
    || approval.updatedAt > snapshot.stateEnteredAt) {
    throw new Error('The exact parked head no longer has its original approval.');
  }
  const mission = readOrchestratorControlPlaneState();
  const packet = mission.packets.find((entry) => entry.id === snapshot.packetId);
  if (!mission.missionId || mission.repoPath !== lane.repoPath || mission.lifecycleHold || !packet
    || packet.status !== 'archived' || !packet.archivedAt || packet.operatorStopped
    || packet.holdIntent === 'operator'
    || packet.releaseState !== 'pending' || packet.lastEventLabel !== 'finished_no_changes'
    || packet.branchTarget !== snapshot.branch || packet.lane?.laneId !== lane.id
    || packet.lane.sessionKey !== lane.sessionKey || packet.lane.repoPath !== lane.repoPath) {
    throw new Error('The current packet no longer belongs to the automatic archive.');
  }
  const identities = snapshot.sessionIdentities.filter((identity) => identity.kind === 'owned-session');
  const identity = identities[0];
  const lifecycle = getOwnedSessionLifecycle(lane.sessionKey);
  const binding = await lifecycle?.getWorkspaceBinding?.(lane.sessionKey);
  if (identities.length !== 1 || identity?.identity !== lane.sessionKey || !identity.bindingId
    || lifecycle?.runtimeId !== lane.runtime || identity.runtime !== lane.runtime
    || !lifecycle.recoverArchivedWorkspace || !binding || binding.sessionState !== 'archived'
    || binding.activeRun || binding.detached !== false || !binding.recordFingerprint
    || !binding.retainedRunsComplete || binding.binding.logicalWorkspaceId !== identity.bindingId
    || binding.binding.packetId !== snapshot.packetId
    || (binding.binding.repositoryUuid !== null && binding.binding.repositoryUuid !== snapshot.repositoryUuid)
    || path.resolve(binding.binding.cwd) !== path.resolve(snapshot.originalPath)) {
    throw new Error('The exact archived session binding is unavailable or changed.');
  }
  await assertArchivedWorkspaceSessionRestorable(
    lifecycle.resolveRoot(), lane.sessionKey, lifecycle.surfaceIdPrefix, binding.recordFingerprint,
  );
  const recovery: ArchivedReviewRecovery = {
    snapshot, lane, laneProof: laneProof(lane), approvalProof: fingerprint(approvals), approvalId: approval.id,
    missionId: mission.missionId, packetProof: packetFingerprint(packet),
    packetGeneration: packetReleaseGeneration(packet, lane.id), binding,
  };
  assertArchivedReviewRecoveryCurrent(recovery, false);
  return recovery;
}

export function assertArchivedReviewRecoveryCurrent(recovery: ArchivedReviewRecovery, restoring = true): void {
  const { snapshot } = recovery;
  const current = getWorkspaceSnapshot(snapshot.repositoryUuid, snapshot.packetId);
  const lane = findLatestLaneByPacket(snapshot.packetId);
  if (!current || current.snapshotGeneration !== snapshot.snapshotGeneration
    || current.snapshotFingerprint !== snapshot.snapshotFingerprint
    || current.version !== snapshot.version + (restoring ? 1 : 0)
    || current.state !== (restoring ? 'restoring' : 'parked')
    || !lane || lane.id !== recovery.lane.id || laneProof(lane) !== recovery.laneProof
    || fingerprint(approvalsFor(snapshot.packetId)) !== recovery.approvalProof) {
    throw new Error('Workspace, lane, approval or operator intent changed during recovery.');
  }
  assertNoActiveWorkspaceArtifactRestore(snapshot.packetId, snapshot.originalPath);
  assertSnapshotRetentionReleased(current);
  const mission = readOrchestratorControlPlaneState();
  const packet = mission.packets.find((entry) => entry.id === snapshot.packetId);
  if (mission.missionId !== recovery.missionId || mission.repoPath !== recovery.lane.repoPath
    || mission.lifecycleHold || !packet || packetFingerprint(packet) !== recovery.packetProof
    || packetReleaseGeneration(packet, lane.id) !== recovery.packetGeneration) {
    throw new Error('Packet ownership or intent changed during recovery.');
  }
}

/** Called inside the session lock after its strict archive inverse succeeds. */
export function publishRecoveredReviewLane(recovery: ArchivedReviewRecovery): void {
  getSqlite().transaction(() => {
    assertArchivedReviewRecoveryCurrent(recovery);
    const lane = updateLane(recovery.lane.id, {
      status: 'reviewing', worktreePath: recovery.snapshot.originalPath,
      outcome: null, outcomeNote: null, lastEventAt: new Date().toISOString(), lastEventLabel: 'parked_archive_recovery',
    }, 'user', { phase: 'parked_archive_recovery', approvalId: recovery.approvalId,
      snapshotGeneration: recovery.snapshot.snapshotGeneration, originalSnapshotVersion: recovery.snapshot.version });
    if (!lane) throw new Error('Recovery lane disappeared before publication.');
    recovery.laneProof = laneProof(lane);
  })();
}

/** Keep partial publication quarantined until BOTH packet and snapshot commit. */
export async function completeArchivedReviewRecovery(
  recovery: ArchivedReviewRecovery, completeSnapshot: () => WorkspaceSnapshotRecord,
): Promise<WorkspaceSnapshotRecord> {
  return withControlPlaneLock(() => {
    assertArchivedReviewRecoveryCurrent(recovery);
    const mission = readOrchestratorControlPlaneState();
    const packet = mission.packets.find((entry) => entry.id === recovery.snapshot.packetId)!;
    packet.status = 'awaiting_review';
    packet.archivedAt = null;
    packet.queueState = 'held';
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = 'workspace_restored';
    packet.lane!.worktreePath = recovery.snapshot.originalPath;
    const persisted = writeOrchestratorControlPlaneState(mission);
    recovery.packetProof = packetFingerprint(persisted.packets.find((entry) => entry.id === packet.id)!);
    return getSqlite().transaction(() => {
      assertArchivedReviewRecoveryCurrent(recovery);
      const result = completeSnapshot();
      appendEvent(recovery.lane.id, 'update', 'user', { phase: 'parked_archive_recovery_complete',
        approvalId: recovery.approvalId, headCommit: result.headCommit });
      return result;
    })();
  });
}
