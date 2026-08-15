import path from 'node:path';

import { findLaneByPacket } from '@/lib/lane/registry';
import { findOwnedLaunchByMutationId } from '@/lib/runtimes/shared/owned-session-index';
import type { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import type { OrchestratorPacket, WorkerRouting } from './types';

export function packetStorageLaunchGeneration(packet: OrchestratorPacket): number {
  const budgetGeneration = (packet.launchAttempts ?? 0) + 1;
  const lifecycleGeneration = Number.isSafeInteger(packet.storageAdmissionEpoch)
    && (packet.storageAdmissionEpoch ?? 0) > 0
    ? packet.storageAdmissionEpoch!
    : 1;
  const prior = packet.storageAdmission;
  if (!prior || prior.ownerId !== packet.id) {
    return Math.max(budgetGeneration, lifecycleGeneration);
  }
  if (!Number.isSafeInteger(prior.ownerGeneration) || prior.ownerGeneration <= 0) {
    throw new Error('The prior storage admission owner generation is invalid.');
  }
  return nextStorageOwnerGeneration(Math.max(
    budgetGeneration - 1,
    lifecycleGeneration - 1,
    prior.ownerGeneration,
  ));
}

function nextStorageOwnerGeneration(generation: number): number {
  const next = generation + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error('The next storage admission owner generation is outside the safe integer range.');
  }
  return next;
}

export async function findExactCommittedLaunch(
  packet: OrchestratorPacket,
  ownerGeneration: number,
  workerRouting?: WorkerRouting,
) {
  const lane = findLaneByPacket(packet.id);
  if (
    !lane?.sessionKey
    || !lane.worktreePath
    || !packet.workspaceTargetPath
    || path.resolve(lane.repoPath) !== path.resolve(packet.workspaceTargetPath)
    || lane.branch !== packet.branchTarget
    || (workerRouting && lane.runtime !== workerRouting.selectedRuntime)
  ) return null;
  const launch = await findOwnedLaunchByMutationId(
    `packet-launch:${packet.id}:${ownerGeneration}`,
  );
  if (
    !launch
    || launch.outcome !== 'running'
    || launch.laneId !== lane.id
    || launch.packetId !== packet.id
    || launch.surfaceId !== lane.sessionKey
    || path.resolve(launch.repoPath) !== path.resolve(packet.workspaceTargetPath)
    || path.resolve(launch.cwd) !== path.resolve(lane.worktreePath)
  ) return null;
  return lane;
}

export async function durableStorageLaunchGeneration(
  packet: OrchestratorPacket,
  store: StorageAdmissionStore,
): Promise<number> {
  const packetGeneration = packetStorageLaunchGeneration(packet);
  const latest = store.getLatestReservationForOwner(packet.id);
  if (!latest || packetGeneration > latest.ownerGeneration) return packetGeneration;
  if (packet.storageAdmission?.ownerId === packet.id) {
    return Math.max(packetGeneration, nextStorageOwnerGeneration(latest.ownerGeneration));
  }
  if (latest.state === 'reserved') return latest.ownerGeneration;
  if (latest.state === 'committed') {
    return latest.ownerGeneration;
  }
  return nextStorageOwnerGeneration(latest.ownerGeneration);
}
