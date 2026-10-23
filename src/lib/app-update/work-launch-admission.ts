/** Cross-process readers for process starts. Native restart is the exclusive writer. */
import { spawn as nodeSpawn } from '@/lib/providers/child-process';
import { randomUUID } from 'node:crypto';
import { constants, existsSync, closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { staleWorkLease, workLeaseState, workLeaseOwner, type WorkLeaseOwner } from './work-lease-owner';
import { inspectCliOperationAdmission } from '@/lib/setup/cli-operation-admission-shared';
import { getDataDir } from '../data-dir-migration';

export interface WorkLaunch extends WorkLeaseOwner { id: string; label: string; pid: number | null }
export interface WorkLaunchLease { id: string; started(pid: number | undefined): void; release(): void }

export class WorkAdmissionExpiredError extends Error {
  constructor() { super('Work admission expired or restart reserved it before the process bound.'); }
}

function assertNoRestart(root: string): void {
  if (existsSync(join(root, 'cli-operation-admission')) && inspectCliOperationAdmission().blocked) {
    throw new WorkAdmissionExpiredError();
  }
}

/** Bind the existing reader, including across a delayed terminal-host IPC request. */
export function bindWorkLaunch(id: string, pid: number | undefined): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new WorkAdmissionExpiredError();
  const root = getDataDir();
  const directory = join(root, 'work-launches');
  const path = join(directory, `${id}.json`);
  assertNoRestart(root);
  let file: number;
  try {
    const directoryMetadata = lstatSync(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new WorkAdmissionExpiredError();
    // Never create a reclaimed reader or follow a replacement symlink.
    file = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new WorkAdmissionExpiredError();
    throw error;
  }
  try {
    const original = fstatSync(file);
    const sameReader = () => {
      try {
        const current = lstatSync(path);
        return current.isFile() && !current.isSymbolicLink() && current.ino === original.ino && current.dev === original.dev;
      } catch { return false; }
    };
    if (!sameReader()) throw new WorkAdmissionExpiredError();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as WorkLaunch;
    if (stored.id !== id || staleWorkLease(stored, path)) throw new WorkAdmissionExpiredError();
    if (pid && Number.isSafeInteger(pid) && pid > 0) {
      const contents = JSON.stringify({ ...stored, pid });
      writeSync(file, contents, 0, 'utf8');
      ftruncateSync(file, Buffer.byteLength(contents));
    }
    // Native publishes its writer before reading/reclaiming launch readers.
    // If it saw the unbound snapshot, binding must fail and cancel the launch.
    if (fstatSync(file).nlink === 0 || !sameReader()) throw new WorkAdmissionExpiredError();
    assertNoRestart(root);
  } finally { closeSync(file); }
}

export function reserveWorkLaunch(label: string): WorkLaunchLease {
  const root = getDataDir();
  const directory = join(root, 'work-launches');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Work launch inventory is unconfirmed.');
  const work: WorkLaunch = { id: randomUUID(), label: label.slice(0, 200), ...workLeaseOwner(), pid: null };
  const path = join(directory, `${work.id}.json`);
  writeFileSync(path, JSON.stringify(work), { flag: 'wx', mode: 0o600 });
  const release = () => { try { unlinkSync(path); } catch { /* Unknown work stays held. */ } };
  // Publish the reader first, then inspect the writer. Whichever wins is visible
  // to the other before it may spawn or commit cleanup. An empty writer directory
  // is also held while its unique ownership file is being written.
  if (existsSync(join(root, 'cli-operation-admission')) && inspectCliOperationAdmission().blocked) {
    release();
    throw new Error('App restart or CLI operation reserved admission. Retry after it finishes.');
  }
  return { id: work.id, started: pid => bindWorkLaunch(work.id, pid), release };
}

export function listWorkLaunches(): WorkLaunch[] {
  const directory = join(getDataDir(), 'work-launches');
  let names: string[];
  try {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Work launch inventory is unconfirmed.');
    names = readdirSync(directory);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.map(name => {
    const path = join(directory, name);
    let work: WorkLaunch;
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Work launch owner is unconfirmed.');
      work = JSON.parse(readFileSync(path, 'utf8')) as WorkLaunch;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && staleWorkLease(null, path)) return null;
      throw error;
    }
    const state = workLeaseState(work, path);
    if (state !== 'live') {
      // Only native's exclusive writer physically reclaims an expired live
      // reader. Otherwise a stale Node snapshot could unlink a successful bind.
      if (state === 'dead') { try { unlinkSync(path); } catch { /* Already settled. */ } }
      return null;
    }
    if (name !== `${work.id}.json` || !Number.isSafeInteger(work.ownerPid) || work.ownerPid <= 0
      || typeof work.label !== 'string' || (work.pid !== null && (!Number.isSafeInteger(work.pid) || work.pid <= 0))) {
      throw new Error('Work launch ownership is unavailable.');
    }
    if (work.pid) {
      try { process.kill(work.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(join(directory, name)); return null; }
      }
    }
    return work;
  }).filter((work): work is WorkLaunch => work !== null);
}

/** Non-spawn work binds to its owner and holds admission through durable settlement. */
export async function withWorkAdmission<T>(label: string, task: () => Promise<T>, refused: (error: unknown) => T): Promise<T> {
  let lease: WorkLaunchLease;
  try { lease = reserveWorkLaunch(label); }
  catch (error) { return refused(error); }
  try {
    try { lease.started(process.pid); } catch (error) { return refused(error); }
    return await task();
  } finally { lease.release(); }
}

/** Retain ownership through exit, including any asynchronous session registration. */
export const spawnWithWorkAdmission: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
  const lease = reserveWorkLaunch(args[0]);
  let spawned = false;
  try {
    lease.started(process.pid);
    const child = Reflect.apply(nodeSpawn, undefined, args) as ReturnType<typeof nodeSpawn>;
    spawned = true;
    // A failed PID write must preserve the already published uncertain reader.
    // The process is already alive, so returning it also preserves caller cleanup.
    try { lease.started(child.pid); } catch (error) {
      if (error instanceof WorkAdmissionExpiredError) {
        child.kill('SIGKILL');
        lease.release();
        throw error;
      }
      // An I/O fault retains the uncertain reader until confirmed exit.
    }
    child.once('error', () => { if (!child.pid) lease.release(); });
    child.once('exit', lease.release);
    return child;
  } catch (error) { if (!spawned) lease.release(); throw error; }
}) as typeof nodeSpawn;
