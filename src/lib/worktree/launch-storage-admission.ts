import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { getSqlite } from '@/lib/db';
import {
  getPacketStorageAdmissionCoordinator,
  PacketStorageAdmissionError,
} from '@/lib/orchestrator/storage-admission';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';
import type { StorageRootIdentity } from '@/lib/workspace/storage-admission';
import { probeMetadataLockProcessIdentity } from './metadata-lock-process-identity';
import {
  assertManagedWorktreeMaterializationBoundary,
  resolveManagedWorktreeStorageTarget,
} from './root-layout';

interface ManagedWorktreeAdmissionInput {
  repoRoot: string;
  packetId?: string;
  reservationId?: string;
}

export async function withManagedWorktreeStorageAdmission<T>(
  input: ManagedWorktreeAdmissionInput,
  materialize: (volumeId: string, rootIdentity: StorageRootIdentity) => Promise<T>,
): Promise<T> {
  const canonicalRepo = await realpath(input.repoRoot);
  const rootKey = createHash('sha256').update(canonicalRepo).digest('hex');
  return withPacketLifecycleMutationLock(`managed-worktree-root:${rootKey}`, () => (
    withManagedWorktreeStorageAdmissionUnlocked(input, materialize)
  ));
}

async function withManagedWorktreeStorageAdmissionUnlocked<T>(
  input: ManagedWorktreeAdmissionInput,
  materialize: (volumeId: string, rootIdentity: StorageRootIdentity) => Promise<T>,
): Promise<T> {
  if (input.reservationId) {
    const reservation = new StorageAdmissionStore(getSqlite()).getReservation(input.reservationId);
    if (!reservation
      || reservation.state !== 'reserved'
      || !reservation.rootIdentity
      || reservation.ownerId !== input.packetId
      || reservation.targetPath !== resolveManagedWorktreeStorageTarget(input.repoRoot)
      || reservation.leaseExpiresAt <= Date.now()) {
      throw new Error('Managed worktree storage admission proof is missing, stale, or belongs to another packet.');
    }
    await assertManagedWorktreeMaterializationBoundary(
      input.repoRoot, reservation.volumeId, reservation.rootIdentity,
    );
    return materialize(reservation.volumeId, reservation.rootIdentity);
  }

  const ownerProbe = await probeMetadataLockProcessIdentity(process.pid);
  if (ownerProbe.state !== 'live') {
    throw new Error('Managed worktree admission could not prove its process owner.');
  }
  const encodedOwner = Buffer.from(JSON.stringify(ownerProbe.identity)).toString('base64url');
  const ownerId = `managed-worktree-process:${process.pid}:${encodedOwner}:${input.packetId ?? randomUUID()}`;
  const packet = {
    id: ownerId,
    workspaceTargetPath: input.repoRoot,
    storageAdmissionEpoch: 1,
    launchAttempts: 0,
  } as OrchestratorPacket;
  const admission = getPacketStorageAdmissionCoordinator();
  const lease = await admission.reserveForLaunch(packet);
  if (lease.receipt.state !== 'reserved') {
    throw new PacketStorageAdmissionError('Managed worktree creation was not reserved.', lease.receipt);
  }
  let result: T;
  try {
    const rootIdentity = lease.reservation.rootIdentity;
    if (!rootIdentity) throw new Error('Managed worktree reservation has no exact root identity.');
    await assertManagedWorktreeMaterializationBoundary(
      input.repoRoot, lease.reservation.volumeId, rootIdentity,
    );
    result = await materialize(lease.reservation.volumeId, rootIdentity);
  } catch (error) {
    await admission.settleFailedLaunch(packet, lease);
    throw error;
  }
  await admission.commitAfterLaunch(lease);
  return result;
}
