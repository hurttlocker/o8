import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity, type MetadataLockProcessProbe } from '@/lib/worktree/metadata-lock-process-identity';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';
import { probeOwnedRunProcessClaim } from './run-process-proof';

const execFileAsync = promisify(execFile);
export type OwnedProcessEvidence = { pid?: number; processIdentity?: MetadataLockProcessIdentity; processIdentityRequired?: boolean };
export type OwnedIdentityProbe = { state: 'match' | 'absent' | 'mismatch' } | { state: 'unknown'; detail: string };

export class OwnedProcessIdentityError extends Error {
  constructor(state: 'mismatch' | 'unknown') {
    super(`Owned worker process identity is ${state}; its saved run remains held without reattachment or automatic retry.`);
  }
}

/** Darwin ps display times lose microseconds. Use the already bundled native helper. */
export async function probeOwnedProcessIdentity(pid: number): Promise<MetadataLockProcessProbe> {
  if (process.platform !== 'darwin') return probeMetadataLockProcessIdentity(pid);
  try {
    const { stdout } = await execFileAsync(piWriteHelperPath(), ['process-identity', String(pid)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192, windowsHide: true,
    });
    const value: unknown = JSON.parse(stdout);
    if (isMetadataLockProcessIdentity(value) && value.platform === 'darwin' && /^kernel:\d+:\d{6}$/.test(value.startId)) {
      return { state: 'live', identity: value };
    }
  } catch { /* Missing helpers and unsupported old builds grant no identity. */ }
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'absent' };
  }
  return { state: 'unknown', detail: 'Kernel worker process identity is unavailable.' };
}

export async function probeOwnedRunIdentity(run: OwnedProcessEvidence): Promise<OwnedIdentityProbe> {
  if (!run.pid || !Number.isSafeInteger(run.pid) || run.pid <= 0) return { state: 'unknown', detail: 'Worker PID is unavailable.' };
  const actual = await probeOwnedProcessIdentity(run.pid);
  if (actual.state !== 'live') return actual;
  if (!isMetadataLockProcessIdentity(run.processIdentity)) return { state: 'unknown', detail: 'Worker start identity was not persisted.' };
  return { state: sameMetadataLockProcessIdentity(actual.identity, run.processIdentity) ? 'match' : 'mismatch' };
}

/** A missing root must not grant group signal authority to a legacy record. */
export async function probeOwnedSignalIdentity(run: OwnedProcessEvidence): Promise<OwnedIdentityProbe> {
  if (!isMetadataLockProcessIdentity(run.processIdentity) || run.processIdentity.platform !== process.platform
    || (process.platform === 'darwin' && !/^kernel:\d+:\d{6}$/.test(run.processIdentity.startId))) {
    return { state: 'unknown', detail: 'Worker kernel start identity was not persisted.' };
  }
  return probeOwnedRunIdentity(run);
}

/** Never settle or retry an unidentified survivor as though it were a dead run. */
export async function assertOwnedSessionProcessIdentity(session: OwnedSessionRecord, runtimeId: string): Promise<void> {
  const run = session.activeRun;
  if (!run || run.spawnState === 'prepared' || run.finishedAt || run.tmuxSession
    || process.platform === 'win32' || runtimeId !== 'codex' || !session.packetId) return;
  const proof = await probeOwnedRunIdentity(run);
  if (proof.state === 'mismatch' || proof.state === 'unknown') throw new OwnedProcessIdentityError(proof.state);
}

export async function captureOwnedRunIdentity(session: OwnedSessionRecord, runtimeId: string, run: OwnedRunRecord): Promise<void> {
  if (runtimeId !== 'codex' || !session.packetId || process.platform === 'win32' || run.detachMode !== 'detached') return;
  run.processIdentityRequired = true;
  const proof = await probeOwnedProcessIdentity(run.pid);
  if (proof.state === 'live' && run.processMarker) {
    const claim = await probeOwnedRunProcessClaim({ pid: run.pid, marker: run.processMarker, rootPid: run.pid });
    const again = await probeOwnedProcessIdentity(run.pid);
    if (claim.state === 'match' && again.state === 'live' && sameMetadataLockProcessIdentity(proof.identity, again.identity)) {
      run.processIdentity = proof.identity;
    }
  }
}
