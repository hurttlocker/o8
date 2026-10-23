import 'server-only';

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { staleWorkLease, workLeaseOwner, type WorkLeaseOwner } from '@/lib/app-update/work-lease-owner';
import { getDataDir } from '@/lib/data-dir-migration';

const DIRECTORY = 'cli-operation-admission';
const ID = /^[0-9a-f-]{36}$/;

interface Operation extends Partial<WorkLeaseOwner> {
  version: 1;
  id: string;
  kind: 'installer' | 'restart';
  pid: number;
  runtime?: string;
  startedAt: string;
  stage: string;
}

export interface CliInstallerActivity {
  runtime: string;
  state: 'active' | 'interrupted' | 'unconfirmed';
  startedAt: string | null;
}

export class CliOperationRefusal extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) { super(message); }
}

function ownerAlive(pid: number): boolean | null {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
}

function readOperation(directory: string, reservationId?: string): Operation | 'unknown' | null {
  try {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return 'unknown';
    const entries = reservationId ? [`${reservationId}.json`] : readdirSync(directory);
    if (entries.length !== 1 || !entries[0].endsWith('.json')) return 'unknown';
    const id = entries[0].slice(0, -5);
    if (!ID.test(id)) return 'unknown';
    const ownerPath = join(directory, entries[0]);
    const metadata = lstatSync(ownerPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return 'unknown';
    const operation = JSON.parse(readFileSync(ownerPath, 'utf8')) as Partial<Operation>;
    if (operation.version !== 1 || operation.id !== id || !Number.isSafeInteger(operation.pid) || operation.pid! <= 0
      || (operation.kind !== 'installer' && operation.kind !== 'restart') || typeof operation.startedAt !== 'string'
      || (operation.kind === 'installer' && typeof operation.runtime !== 'string')) return 'unknown';
    return operation as Operation;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(directory) ? null : 'unknown'; }
}

/** Unique owner files make an old cleanup unable to remove a replacement lease. */
function releaseOperation(directory: string, operation: Operation): boolean {
  const current = readOperation(directory, operation.id);
  if (!current || current === 'unknown' || current.id !== operation.id || current.pid !== operation.pid) return false;
  try {
    unlinkSync(join(directory, `${operation.id}.json`));
    rmdirSync(directory); // Never recursive: another owner's contents must survive.
    return true;
  } catch { return false; }
}

function inspectCliOperationAdmissionInner(reservationId?: string): {
  blocked: boolean;
  installers: CliInstallerActivity[];
  code?: string;
  message?: string;
} {
  const dataDir = getDataDir();
  const directory = join(dataDir, DIRECTORY);
  if (existsSync(directory) && lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink()) {
    const emptyExpired = staleWorkLease(null, directory);
    let recovered = false;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
      let owner: unknown = null;
      try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Partial/legacy writer: bounded grace. */ }
      if (staleWorkLease(owner, path)) { unlinkSync(path); recovered = true; }
    }
    if (recovered || emptyExpired) { try { rmdirSync(directory); } catch { /* A live owner retains the writer. */ } }
  }
  const operation = readOperation(directory);
  let legacy: string[];
  try { legacy = readdirSync(dataDir).filter(name => {
    if (!name.endsWith('-cli-update.lock')) return false;
    const path = join(dataDir, name);
    let owner: unknown = null;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Legacy record: bounded grace. */ }
    if (staleWorkLease(owner, path)) { unlinkSync(path); return false; }
    return true;
  }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { blocked: true, installers: [],
      code: 'cli_update_inventory_unavailable', message: 'CLI update ownership could not be checked. Retry when its status is available.' };
    legacy = [];
  }
  const installers: CliInstallerActivity[] = [];
  if (operation && operation !== 'unknown' && operation.kind === 'installer') {
    const alive = ownerAlive(operation.pid);
    installers.push({ runtime: operation.runtime ?? 'CLI', state: alive === true ? 'active' : alive === false ? 'interrupted' : 'unconfirmed', startedAt: operation.startedAt });
  }
  for (const name of legacy) {
    const runtime = name.slice(0, -'-cli-update.lock'.length);
    if (!installers.some(item => item.runtime === runtime)) installers.push({ runtime, state: 'unconfirmed', startedAt: null });
  }
  const ownRestart = operation && operation !== 'unknown' && operation.kind === 'restart' && operation.id === reservationId;
  const blocked = (operation !== null && !ownRestart) || legacy.length > 0;
  const uncertain = operation === 'unknown' || installers.some(item => item.state !== 'active');
  return { blocked, installers, ...(blocked ? {
    code: uncertain ? 'cli_update_recovery_required' : operation && operation.kind === 'restart' ? 'app_restart_pending' : 'cli_update_in_progress',
    message: uncertain
      ? 'An interrupted or unconfirmed CLI update needs recovery. Verify the selected tool and its update receipt before clearing its owner hold; no lock was removed.'
      : operation && operation.kind === 'restart'
        ? 'An app restart is already reserved. Wait for it to finish.'
        : 'A CLI update is in progress. Wait for it to finish; no work was stopped.',
  } : {}) };
}

/** Readers race with settlement/recovery; uncertainty is data, never an uncaught route error. */
export function inspectCliOperationAdmission(reservationId?: string): ReturnType<typeof inspectCliOperationAdmissionInner> {
  try { return inspectCliOperationAdmissionInner(reservationId); }
  catch { return { blocked: true, installers: [], code: 'cli_update_inventory_unavailable',
    message: 'CLI update ownership changed during inspection. Retry or explicitly force restart.' }; }
}

export interface CliInstallerReservation { id: string; owner: WorkLeaseOwner; release(): void }

export function reserveCliInstaller(runtime: string): CliInstallerReservation {
  const state = inspectCliOperationAdmission();
  if (state.blocked) throw new CliOperationRefusal(state.code!, state.message!);
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  const directory = join(dataDir, DIRECTORY);
  const owner = workLeaseOwner();
  const operation: Operation = { ...owner, version: 1, id: randomUUID(), kind: 'installer', runtime,
    pid: process.pid, startedAt: new Date().toISOString(), stage: 'reserved' };
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch { throw new CliOperationRefusal('cli_operation_busy', 'Another CLI update or app restart won admission. Retry after it finishes.'); }
  try { writeFileSync(join(directory, `${operation.id}.json`), JSON.stringify(operation), { flag: 'wx', mode: 0o600 }); }
  catch (error) { try { rmdirSync(directory); } catch { /* Preserve an uncertain owner. */ } throw error; }
  return { id: operation.id, owner, release: () => { releaseOperation(directory, operation); } };
}

export async function withCliInstallerReservation<T>(runtime: string, task: (reservation: CliInstallerReservation) => Promise<T>): Promise<T> {
  const reservation = reserveCliInstaller(runtime);
  try { return await task(reservation); } finally { reservation.release(); }
}

export function releaseOwnedCliUpdateLock(path: string, operationId: string): void {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8')) as { operationId?: unknown };
    if (owner.operationId === operationId) unlinkSync(path);
  } catch { /* Keep legacy, replaced and uncertain owners for explicit recovery. */ }
}

/** Only an authenticated native caller with the live reservation can inspect under it. */
export function validRestartReservation(id: unknown): id is string {
  if (typeof id !== 'string' || !ID.test(id)) return false;
  const operation = readOperation(join(getDataDir(), DIRECTORY), id);
  return Boolean(operation && operation !== 'unknown' && operation.kind === 'restart'
    && operation.id === id && ownerAlive(operation.pid) === true
    && !staleWorkLease(operation, join(getDataDir(), DIRECTORY, `${id}.json`)));
}
