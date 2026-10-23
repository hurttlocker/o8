import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity, type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { readExactChildFile, writeExactChildFile } from './exact-parent-operation';
import { purgeExactDirectory } from './exact-directory-purge';
import { StorageAdmissionStore } from './storage-admission';

interface PoolOwner {
  schema: 'o8/dependency-pool-owner/v1';
  parent: WorktreeMaterializationIdentity;
  pid: number;
  process: MetadataLockProcessIdentity;
  reservationId: string;
}

export function dependencyPoolOwner(parent: WorktreeMaterializationIdentity, reservationId: string): PoolOwner {
  const probe = probeMetadataLockProcessIdentitySync(process.pid);
  if (probe.state !== 'live') throw new Error('Dependency pool process identity unavailable.');
  return { schema: 'o8/dependency-pool-owner/v1', parent, pid: process.pid, process: probe.identity, reservationId };
}

async function readOwner(parent: WorktreeMaterializationIdentity, name: string): Promise<PoolOwner | null> {
  try {
    const entry = await lstat(path.join(parent.canonicalPath, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 4096) return null;
    const owner = JSON.parse((await readExactChildFile(parent.canonicalPath, parent, path.join(parent.canonicalPath, name))).contents) as PoolOwner;
    if (owner.schema !== 'o8/dependency-pool-owner/v1' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !owner.process || owner.process.version !== 1 || !owner.process.bootId || !owner.process.startId
      || typeof owner.reservationId !== 'string' || !owner.reservationId.startsWith('dependency-pool:')) return null;
    await assertWorktreeMaterializationIdentity(parent.canonicalPath, owner.parent);
    return owner;
  } catch { return null; }
}

async function dead(owner: PoolOwner): Promise<boolean> {
  const probe = await probeMetadataLockProcessIdentity(owner.pid);
  return probe.state === 'absent' || (probe.state === 'live' && JSON.stringify(probe.identity) !== JSON.stringify(owner.process));
}

/** Only a proven-dead process permits interrupted-slot retirement. Unknown stays held. */
export async function recoverDependencyPoolSlot(slot: string, root: WorktreeMaterializationIdentity): Promise<void> {
  try {
    await withPacketLifecycleSpawnLock(`dependency-pool-recovery:${slot}`, async () => {
      await assertWorktreeMaterializationIdentity(root.canonicalPath, root);
      const parent = await captureWorktreeMaterializationIdentity(slot);
      if (parent.canonicalPath !== path.join(root.canonicalPath, path.basename(slot))) return;
      const owner = await readOwner(parent, 'owner.json');
      if (!owner) return;
      let hasClaim = false;
      try { await lstat(path.join(slot, 'claimed')); hasClaim = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!hasClaim) {
        try { await lstat(path.join(slot, 'ready.json')); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const currentOwner = hasClaim ? await readOwner(parent, 'claimed') : owner;
      if (!currentOwner || !await dead(currentOwner)) return;
      await assertWorktreeMaterializationIdentity(root.canonicalPath, root);
      const store = new StorageAdmissionStore(getSqlite());
      const reservation = store.getReservation(owner.reservationId);
      if (reservation?.state === 'reserved') {
        if (reservation.ownerId !== owner.reservationId || !await dead(owner)) return;
        const mutation = { mutationId: `dependency-pool-recovery:${randomUUID()}`, reservationId: reservation.reservationId,
          volumeId: reservation.volumeId, ownerId: reservation.ownerId, ownerGeneration: reservation.ownerGeneration,
          expectedGeneration: reservation.generation };
        const released = await store.reconcile({ ...mutation, ownerLiveness: 'dead', ownerDeathReceipt: {
          ...mutation, source: 'dependency-pool-process-identity', evidence: 'Recorded process is absent or its boot/start identity differs.', observedAt: Date.now(),
        } });
        if (released.decision !== 'reconciled') return;
      }
      // A fresh process observation follows ledger reconciliation and precedes deletion.
      if (!await dead(currentOwner)) return;
      await assertWorktreeMaterializationIdentity(root.canonicalPath, root);
      await purgeExactDirectory(slot, parent);
    });
  } catch { /* A live recovery owner or an unproved slot remains bounded and held. */ }
}

export async function claimDependencyPoolSlot(parent: WorktreeMaterializationIdentity): Promise<boolean> {
  try {
    await writeExactChildFile(parent.canonicalPath, parent, path.join(parent.canonicalPath, 'claimed'),
      JSON.stringify(dependencyPoolOwner(parent, `dependency-pool:claim:${randomUUID()}`)), 0o600);
    return true;
  } catch { return false; }
}
