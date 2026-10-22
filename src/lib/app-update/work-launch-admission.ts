/** Cross-process readers for process starts. Native restart is the exclusive writer. */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../data-dir-migration';

export interface WorkLaunch { id: string; label: string; ownerPid: number; pid: number | null }
export interface WorkLaunchLease { started(pid: number | undefined): void; release(): void }

export function reserveWorkLaunch(label: string): WorkLaunchLease {
  const root = getDataDir();
  const directory = join(root, 'work-launches');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const work: WorkLaunch = { id: randomUUID(), label: label.slice(0, 200), ownerPid: process.pid, pid: null };
  const path = join(directory, `${work.id}.json`);
  const save = () => writeFileSync(path, JSON.stringify(work), { mode: 0o600 });
  writeFileSync(path, JSON.stringify(work), { flag: 'wx', mode: 0o600 });
  const release = () => { try { unlinkSync(path); } catch { /* Unknown work stays held. */ } };
  // Publish the reader first, then inspect the writer. Whichever wins is visible
  // to the other before it may spawn or commit cleanup. An empty writer directory
  // is also held while its unique ownership file is being written.
  if (existsSync(join(root, 'cli-operation-admission'))) {
    release();
    throw new Error('App restart or CLI operation reserved admission. Retry after it finishes.');
  }
  return { started(pid) { if (pid && Number.isSafeInteger(pid) && pid > 0) { work.pid = pid; save(); } }, release };
}

export function listWorkLaunches(): WorkLaunch[] {
  const directory = join(getDataDir(), 'work-launches');
  let names: string[];
  try { names = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.map(name => {
    const work = JSON.parse(readFileSync(join(directory, name), 'utf8')) as WorkLaunch;
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
