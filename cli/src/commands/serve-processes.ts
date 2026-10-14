import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, EXIT } from '../api.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '../../../src/lib/worktree/metadata-lock-process-identity.js';

const exec = promisify(execFile);
export interface ServeProcessClaim { pid: number; identity: MetadataLockProcessIdentity }
interface ProcessRow { pid: number; parent: number; zombie: boolean }

async function processTable(): Promise<Map<number, ProcessRow>> {
  const rows = new Map<number, ProcessRow>();
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 });
    for (const row of JSON.parse(stdout) as Array<{ProcessId:number;ParentProcessId:number}>) {
      rows.set(row.ProcessId, { pid: row.ProcessId, parent: row.ParentProcessId, zombie: false });
    }
  } else {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,stat='], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.trim().split('\n')) {
      const [pid, parent, status] = line.trim().split(/\s+/);
      if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(parent ?? '') || !status) throw new Error('Invalid process table.');
      rows.set(Number(pid), { pid: Number(pid), parent: Number(parent), zombie: status.startsWith('Z') });
    }
  }
  return rows;
}

export async function serveProcessClaim(pid: number): Promise<ServeProcessClaim> {
  const probe = await probeMetadataLockProcessIdentity(pid);
  if (probe.state !== 'live') throw new Error(`Process ${pid} has no verifiable birth identity.`);
  return { pid, identity: probe.identity };
}

async function claimIsLive(claim: ServeProcessClaim, rows: Map<number, ProcessRow>): Promise<boolean> {
  const row = rows.get(claim.pid);
  if (!row || row.zombie) return false;
  const probe = await probeMetadataLockProcessIdentity(claim.pid);
  if (probe.state === 'absent') return false;
  if (probe.state !== 'live' || !claim.identity || !sameMetadataLockProcessIdentity(claim.identity, probe.identity)) {
    throw new Error(`Process ${claim.pid} ownership changed or cannot be verified.`);
  }
  return true;
}

/** Capture before signaling ancestors so detached children remain attributable after reparenting. */
export async function captureServeProcesses(seeds: ServeProcessClaim[]): Promise<ServeProcessClaim[]> {
  const rows = await processTable();
  const claims = new Map<number, ServeProcessClaim>();
  const live = new Set<number>();
  for (const seed of seeds) {
    claims.set(seed.pid, seed);
    if (await claimIsLive(seed, rows)) live.add(seed.pid);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows.values()) {
      if (row.zombie || claims.has(row.pid) || !live.has(row.parent)) continue;
      const claim = await serveProcessClaim(row.pid).catch(() => null);
      if (!claim) {
        if ((await processTable()).has(row.pid)) throw new Error(`Descendant ${row.pid} could not be identified.`);
        continue;
      }
      const current = await processTable();
      if (current.get(row.pid)?.parent !== row.parent || !await claimIsLive(claims.get(row.parent)!, current)) {
        throw new Error(`Descendant ${row.pid} ancestry changed before capture.`);
      }
      claims.set(row.pid, claim); live.add(row.pid); changed = true;
    }
  }
  return [...claims.values()];
}

export async function stopServeProcesses(
  seeds: ServeProcessClaim[],
  retain: (claims: ServeProcessClaim[]) => void,
): Promise<{ confirmedDead: boolean; processes: ServeProcessClaim[] }> {
  let claims = await captureServeProcesses(seeds);
  if (claims.some((claim) => claim.pid === process.pid)) {
    throw new Error('Refusing to stop the process executing this command.');
  }
  retain(claims);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    claims = await captureServeProcesses(claims);
    retain(claims);
    // Stop supervising ancestors first so child exits cannot trigger replacements.
    // Descendants were captured before any ancestor can orphan them.
    for (const claim of claims) {
      if (!await claimIsLive(claim, await processTable())) continue;
      try { process.kill(claim.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const deadline = Date.now() + (signal === 'SIGTERM' ? 3_000 : 1_000);
    while (Date.now() < deadline) {
      const rows = await processTable();
      const states = await Promise.all(claims.map((claim) => claimIsLive(claim, rows)));
      if (states.every((live) => !live)) return { confirmedDead: true, processes: claims };
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  return { confirmedDead: false, processes: claims };
}

/** No timed stealing: an interrupted owner leaves evidence and blocks new mutations. */
function acquireFileLock(path: string, waitMs = 0): { id: string; release: () => void } {
  const id = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(path, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new CliError('serve_operation_busy', 'Another lifecycle owner holds this profile; retained locks require ownership reconciliation.', EXIT.CONFLICT);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const ownerFile = join(path, 'owner.json');
  try { writeFileSync(ownerFile, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 }); } catch (error) {
    // Leave an incomplete claim held rather than deleting uncertain ownership.
    throw error;
  }
  return { id, release: () => {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { id: string };
    if (owner.id !== id) throw new Error('Lifecycle lock ownership changed.');
    unlinkSync(ownerFile); rmdirSync(path);
  } };
}

export function acquireServeOperation(dataDir: string): { id: string; release: () => void } {
  return acquireFileLock(join(dataDir, 'serve-operation.lock'));
}

export async function withServeOperation<T>(dataDir: string, operation: (id: string) => Promise<T>): Promise<T> {
  const lease = acquireServeOperation(dataDir);
  try { return await operation(lease.id); } finally { lease.release(); }
}

/** Only synchronous state mutation is allowed inside this short critical section. */
export function withServeStateMutation<T>(stateFile: string, mutation: () => T): T {
  const lease = acquireFileLock(`${stateFile}.lock`, 2_000);
  try { return mutation(); } finally { lease.release(); }
}

export function sameServeGeneration(
  expected: { pid?: number; generation?: string; startedAt?: string },
  current: { pid?: number; generation?: string; startedAt?: string } | null,
): boolean {
  return current !== null && current.pid === expected.pid
    && current.generation === expected.generation
    && (expected.generation !== undefined || current.startedAt === expected.startedAt);
}

export function mergeServeClaims(...sets: Array<ServeProcessClaim[] | undefined>): ServeProcessClaim[] | undefined {
  if (sets.every((set) => set === undefined)) return undefined;
  const claims = new Map<number, ServeProcessClaim>();
  for (const claim of sets.flatMap((set) => set ?? [])) {
    const prior = claims.get(claim.pid);
    if (prior?.identity && claim.identity && !sameMetadataLockProcessIdentity(prior.identity, claim.identity)) {
      throw new Error(`Conflicting birth claims for process ${claim.pid}.`);
    }
    if (!prior?.identity) claims.set(claim.pid, claim);
  }
  return [...claims.values()];
}

export function readOrCreateServeId(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const id = randomUUID();
  try {
    writeFileSync(path, id, { flag: 'wx', mode: 0o600 });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing) return existing;
    }
    throw error;
  }
}
