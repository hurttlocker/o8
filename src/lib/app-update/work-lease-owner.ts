/** One owner/recovery protocol for launch readers, installers and restart writers. */
import { statSync } from 'node:fs';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export const UNBOUND_WORK_LEASE_MS = 30_000;
export interface WorkLeaseOwner {
  ownerPid: number;
  ownerIdentity: MetadataLockProcessIdentity;
  createdAtMs: number;
}

export function workLeaseOwner(): WorkLeaseOwner {
  const owner = probeMetadataLockProcessIdentitySync(process.pid);
  if (owner.state !== 'live') throw new Error('Work admission could not establish its process identity.');
  return { ownerPid: process.pid, ownerIdentity: owner.identity, createdAtMs: Date.now() };
}

/** Absence and PID reuse prove death. Legacy/unbound records have a bounded grace period. */
export function staleWorkLease(value: unknown, path: string): boolean {
  const work = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pid = work.ownerPid ?? work.pid;
  const identity = work.ownerIdentity;
  if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
    const owner = probeMetadataLockProcessIdentitySync(pid);
    if (owner.state === 'absent' || (owner.state === 'live' && isMetadataLockProcessIdentity(identity)
      && !sameMetadataLockProcessIdentity(owner.identity, identity))) return true;
  }
  if (work.pid != null && isMetadataLockProcessIdentity(identity)) return false;
  try {
    const timestamp = typeof work.createdAtMs === 'number' && Number.isFinite(work.createdAtMs)
      ? work.createdAtMs : statSync(path).mtimeMs;
    return Date.now() - timestamp >= UNBOUND_WORK_LEASE_MS;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}
