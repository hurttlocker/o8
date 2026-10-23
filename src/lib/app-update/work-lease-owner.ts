/** One owner/recovery protocol for launch readers, installers and restart writers. */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity, type MetadataLockProcessProbe } from '@/lib/worktree/metadata-lock-process-identity';

export const UNBOUND_WORK_LEASE_MS = 30_000;
export interface WorkLeaseOwner {
  ownerPid: number;
  ownerIdentity: MetadataLockProcessIdentity;
  createdAtMs: number;
  createdMonotonicMs: number;
}

const observed = new Map<string, { stamp: string; since: number }>();
let ownIdentity: MetadataLockProcessIdentity | undefined;
const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;

/** Keep metadata-lock identities unchanged; updater cookies use UTC epoch seconds on macOS. */
function probeWorkOwner(pid: number): MetadataLockProcessProbe {
  if (pid === process.pid && ownIdentity) return { state: 'live', identity: ownIdentity };
  const probe = probeMetadataLockProcessIdentitySync(pid);
  if (probe.state !== 'live') return probe;
  if (probe.identity.platform === 'darwin') {
    try {
      const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 2_000, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' },
      }).trim().replace(/\s+/g, ' ');
      const seconds = Date.parse(`${started} UTC`) / 1_000;
      if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Invalid process start time');
      probe.identity = { ...probe.identity, startId: `epoch:${seconds}` };
    } catch { return { state: 'unknown', detail: 'Work owner process start time is unavailable.' }; }
  }
  if (pid === process.pid) ownIdentity = probe.identity;
  return probe;
}

export function workLeaseOwner(): WorkLeaseOwner {
  const owner = probeWorkOwner(process.pid);
  if (owner.state !== 'live') throw new Error('Work admission could not establish its process identity.');
  return { ownerPid: process.pid, ownerIdentity: owner.identity, createdAtMs: Date.now(), createdMonotonicMs: monotonicMs() };
}

/** Absence and PID reuse prove death. Unbound grace never uses the wall clock. */
export function workLeaseState(value: unknown, path: string): 'live' | 'dead' | 'expired' {
  const work = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const pid = work.ownerPid ?? work.pid;
  const identity = work.ownerIdentity;
  if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
    const owner = probeWorkOwner(pid);
    // Earlier macOS cookies contain local display times; a format change is not PID reuse.
    const comparable = isMetadataLockProcessIdentity(identity)
      && (identity.platform !== 'darwin' || identity.startId.startsWith('epoch:')
        || (owner.state === 'live' && identity.bootId !== owner.identity.bootId));
    if (owner.state === 'absent' || (owner.state === 'live' && comparable
      && !sameMetadataLockProcessIdentity(owner.identity, identity))) return 'dead';
  }
  if (work.pid != null && isMetadataLockProcessIdentity(identity)) return 'live';
  const now = monotonicMs();
  if (typeof work.createdMonotonicMs === 'number' && Number.isFinite(work.createdMonotonicMs)
    && work.createdMonotonicMs >= 0 && work.createdMonotonicMs <= now) {
    return now - work.createdMonotonicMs >= UNBOUND_WORK_LEASE_MS ? 'expired' : 'live';
  }
  // Legacy/partial records lack a shared monotonic timestamp. Observe one bounded
  // grace period locally; file metadata identifies replacement, never elapsed time.
  try {
    const metadata = statSync(path);
    const stamp = `${metadata.ino}:${metadata.mtimeMs}:${metadata.size}`;
    let first = observed.get(path);
    if (!first || first.stamp !== stamp) { first = { stamp, since: now }; observed.set(path, first); }
    return now - first.since >= UNBOUND_WORK_LEASE_MS ? 'expired' : 'live';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'live'; }
}

export function staleWorkLease(value: unknown, path: string): boolean {
  return workLeaseState(value, path) !== 'live';
}
