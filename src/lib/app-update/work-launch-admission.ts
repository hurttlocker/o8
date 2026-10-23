/** Cross-process readers for process starts. Native restart is the exclusive writer. */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staleWorkLease, workLeaseOwner, type WorkLeaseOwner } from './work-lease-owner';
import { inspectCliOperationAdmission } from '@/lib/setup/cli-operation-admission';
import { getDataDir } from '../data-dir-migration';

export interface WorkLaunch extends WorkLeaseOwner { id: string; label: string; pid: number | null }
export interface WorkLaunchLease { started(pid: number | undefined): void; release(): void }

export function reserveWorkLaunch(label: string): WorkLaunchLease {
  const root = getDataDir();
  const directory = join(root, 'work-launches');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Work launch inventory is unconfirmed.');
  const work: WorkLaunch = { id: randomUUID(), label: label.slice(0, 200), ...workLeaseOwner(), pid: null };
  const path = join(directory, `${work.id}.json`);
  const save = () => {
    const temporary = join(root, `${work.id}.tmp`);
    try { writeFileSync(temporary, JSON.stringify(work), { mode: 0o600 }); renameSync(temporary, path); }
    finally { try { unlinkSync(temporary); } catch { /* Rename consumed the temporary. */ } }
  };
  writeFileSync(path, JSON.stringify(work), { flag: 'wx', mode: 0o600 });
  const release = () => { try { unlinkSync(path); } catch { /* Unknown work stays held. */ } };
  // Publish the reader first, then inspect the writer. Whichever wins is visible
  // to the other before it may spawn or commit cleanup. An empty writer directory
  // is also held while its unique ownership file is being written.
  if (existsSync(join(root, 'cli-operation-admission')) && inspectCliOperationAdmission().blocked) {
    release();
    throw new Error('App restart or CLI operation reserved admission. Retry after it finishes.');
  }
  return { started(pid) { if (pid && Number.isSafeInteger(pid) && pid > 0) { work.pid = pid; save(); } }, release };
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
      if (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && staleWorkLease(null, path)) { unlinkSync(path); return null; }
      throw error;
    }
    if (staleWorkLease(work, path)) { unlinkSync(path); return null; }
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
  try { lease.started(process.pid); return await task(); }
  finally { lease.release(); }
}

/** Retain ownership through exit, including any asynchronous session registration. */
export const spawnWithWorkAdmission: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
  const lease = reserveWorkLaunch(args[0]);
  let spawned = false;
  try {
    const child = Reflect.apply(nodeSpawn, undefined, args) as ReturnType<typeof nodeSpawn>;
    spawned = true;
    // A failed PID write must preserve the already published uncertain reader.
    // The process is already alive, so returning it also preserves caller cleanup.
    try { lease.started(child.pid); } catch { /* Retain startup ownership until exit. */ }
    child.once('error', () => { if (!child.pid) lease.release(); });
    child.once('exit', lease.release);
    return child;
  } catch (error) { if (!spawned) lease.release(); throw error; }
}) as typeof nodeSpawn;
