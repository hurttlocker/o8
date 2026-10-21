import { isDeepStrictEqual } from 'node:util';
import { getSqlite } from '@/lib/db';
import { readMissionRegistryEntry, persistMissionRegistryStateIfVersion } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { ResetStateChangedError } from './reset-errors';

export interface RetrySalvageRegistryOwner {
  repoPath: string | null;
  lifecycleHold: OrchestratorMissionState['lifecycleHold'];
  packet: OrchestratorPacket;
}

function packetAuthority(packet: OrchestratorPacket) {
  return {
    storageAdmissionEpoch: packet.storageAdmissionEpoch ?? 0,
    attemptCount: packet.attemptCount ?? 0,
    projectId: packet.projectId ?? null,
    workspaceTargetPath: packet.workspaceTargetPath ?? null,
    branchTarget: packet.branchTarget ?? null,
    laneId: packet.lane?.laneId ?? null,
    sessionKey: packet.lane?.sessionKey ?? null,
    worktreePath: packet.lane?.worktreePath ?? null,
    status: packet.status,
    queueState: packet.queueState,
    operatorStopped: Boolean(packet.operatorStopped),
    holdIntent: packet.holdIntent ?? null,
    manualLaunchClaim: packet.manualLaunchClaim ?? null,
    releaseState: packet.releaseState,
    releaseStatePayload: packet.releaseStatePayload ?? null,
    archivedAt: packet.archivedAt ?? null,
    recovery: packet.recovery ?? null,
    review: packet.review ?? null,
  };
}

function changed(): never {
  throw new ResetStateChangedError('The durable mission owner changed while retry salvage was probing; its current state was preserved.');
}

/** Capture the durable owner before stamping the current-only salvage hold. */
export function captureRetrySalvageRegistryOwner(
  state: OrchestratorMissionState,
  packet: OrchestratorPacket,
): RetrySalvageRegistryOwner | null {
  const entry = readMissionRegistryEntry(state.missionId!, { includeArchived: true });
  if (!entry) {
    if (getSqlite().prepare('SELECT id FROM missions WHERE id = ?').get(state.missionId)) changed();
    return null;
  }
  const stored = entry.mission.packets.find(candidate => candidate.id === packet.id);
  if (!stored || entry.mission.missionId !== state.missionId
    || entry.mission.repoPath !== state.repoPath
    || !isDeepStrictEqual(entry.mission.lifecycleHold, state.lifecycleHold)
    || (stored.storageAdmissionEpoch ?? 0) !== (packet.storageAdmissionEpoch ?? 0)
    || (stored.attemptCount ?? 0) !== (packet.attemptCount ?? 0)
    || stored.projectId !== packet.projectId
    || stored.workspaceTargetPath !== packet.workspaceTargetPath
    || stored.branchTarget !== packet.branchTarget
    || (stored.lane?.laneId ?? null) !== (packet.lane?.laneId ?? null)
    || (stored.lane?.sessionKey ?? null) !== (packet.lane?.sessionKey ?? null)
    || (stored.lane?.worktreePath ?? null) !== (packet.lane?.worktreePath ?? null)
    || !isDeepStrictEqual(stored.releaseStatePayload ?? null, packet.releaseStatePayload ?? null)
    || !isDeepStrictEqual(stored.manualLaunchClaim ?? null, packet.manualLaunchClaim ?? null)
    || Boolean(stored.operatorStopped) !== Boolean(packet.operatorStopped)) changed();
  return { repoPath: entry.mission.repoPath ?? null, lifecycleHold: structuredClone(entry.mission.lifecycleHold), packet: structuredClone(stored) };
}

/** A legacy guard without owner correlation cannot authorize a registered bind. */
export function assertRetrySalvageRegistryOwner(
  missionId: string,
  packetId: string,
  owner: RetrySalvageRegistryOwner | null | undefined,
) {
  const entry = readMissionRegistryEntry(missionId, { includeArchived: true });
  if (!entry) {
    if (owner || getSqlite().prepare('SELECT id FROM missions WHERE id = ?').get(missionId)) changed();
    return null;
  }
  const target = entry.mission.packets.find(packet => packet.id === packetId);
  if (!owner || (entry.mission.repoPath ?? null) !== owner.repoPath || !isDeepStrictEqual(entry.mission.lifecycleHold, owner.lifecycleHold) || !target || !isDeepStrictEqual(packetAuthority(target), packetAuthority(owner.packet))) changed();
  return entry;
}

/** Patch only this packet; a version race preserves the other writer's state. */
export async function publishRetrySalvageRegistryOwner(
  missionId: string,
  packet: OrchestratorPacket,
  owner: RetrySalvageRegistryOwner | null | undefined,
): Promise<void> {
  const entry = assertRetrySalvageRegistryOwner(missionId, packet.id, owner);
  if (!entry) return;
  const target = entry.mission.packets.find(candidate => candidate.id === packet.id)!;
  Object.assign(target, {
    status: packet.status,
    queueState: packet.queueState,
    releaseState: packet.releaseState,
    releaseStatePayload: packet.releaseStatePayload,
    archivedAt: packet.archivedAt,
    blockedReason: packet.blockedReason,
    recovery: packet.recovery,
    review: packet.review,
    operatorStopped: packet.operatorStopped,
    lastEventAt: packet.lastEventAt,
    lastEventLabel: packet.lastEventLabel,
    lane: packet.lane,
  });
  if (!await persistMissionRegistryStateIfVersion(entry.mission, entry.updatedAt)) changed();
}
