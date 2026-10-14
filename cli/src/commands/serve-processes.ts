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
