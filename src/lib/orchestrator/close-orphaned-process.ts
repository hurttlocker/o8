import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { tmuxSessionName } from '@/lib/terminal/tmux';
import { withCapturedPurgeProcessExclusion, type CapturedPurgeProcessWitness } from '@/lib/workspace/exact-directory-purge';

const execFileAsync = promisify(execFile);
export class OrphanCloseRefusal extends Error {
  constructor(reason: string) {
    super(`Close refused: ${reason.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').slice(0, 400)}. The checkout remains held.`);
    this.name = 'OrphanCloseRefusal';
  }
}

export interface OrphanRunIdentity { runId: string; pid: number; processGroupId: number }

async function command(file: string, args: string[], absentExit = false) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (result.stderr.trim()) throw new OrphanCloseRefusal(`${file} probe returned incomplete output`);
    return result.stdout;
  } catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (absentExit && failed.code === 1 && !failed.stdout?.trim()
      && /no server running|no such file|can't find session|no sessions/i.test(failed.stderr ?? '')) return null;
    throw new OrphanCloseRefusal(`${file} process probe is unavailable or inconclusive`);
  }
}

function processName(commandLine: string): string {
  const name = path.basename(commandLine.trim().split(/\s+/)[0] ?? 'process');
  return /^[A-Za-z0-9._-]{1,60}$/.test(name) ? name : 'process';
}

/** No cached inventory: inspect retained PID/group/marker identities and every open descriptor. */
export async function assertOrphanProcessesAbsent(input: {
  capturedPurge?: CapturedPurgeProcessWitness;
  runtime: string;
  runs: OrphanRunIdentity[];
  sourcePath: string;
  candidatePath: string;
}): Promise<void> {
  if (!input.capturedPurge) return inspectOrphanProcesses(input);
  try {
    await withCapturedPurgeProcessExclusion(input.capturedPurge, input.candidatePath,
      (isHelper) => inspectOrphanProcesses(input, isHelper));
  } catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    throw new OrphanCloseRefusal('paused purge helper process attestation is unavailable or inconclusive');
  }
}

async function inspectOrphanProcesses(input: {
  runtime: string; runs: OrphanRunIdentity[]; sourcePath: string; candidatePath: string;
}, isHelper?: (pid: number) => boolean): Promise<void> {
  const raw = await command('ps', ['axeww', '-o', 'pid=,pgid=,ppid=,command=']);
  if (!raw?.trim()) throw new OrphanCloseRefusal('ps returned no process identity snapshot');
  const processes = raw.trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new OrphanCloseRefusal('ps returned malformed process identity output');
    return { pid: Number(match[1]), group: Number(match[2]), parent: Number(match[3]), command: match[4]! };
  });
  for (const run of input.runs) {
    const live = processes.find((row) => row.pid === run.pid || row.group === run.processGroupId
      || row.parent === run.pid || row.command.split(/\s+/).includes(`O8_OWNED_RUN_MARKER=${run.runId}`));
    // A reused PID/group remains a refusal; token rows confer no signaling authority.
    if (live) throw new OrphanCloseRefusal(`live process PID ${live.pid} (${processName(live.command)}) matches retained run identity`);
    const tmux = await command('tmux', ['has-session', '-t', `=${tmuxSessionName(input.runtime, run.runId)}`], true);
    if (tmux !== null) throw new OrphanCloseRefusal('a retained run tmux session is still live');
  }

  // Request file delimiters explicitly: Linux omits f fields unless selected.
  // Global descriptors also cover deleted files and the source-to-claim rename.
  // Never log this output; only report holders of the two exact namespaces.
  const files = await command('lsof', ['-nP', '-Fpcftn']);
  if (!files?.trim()) throw new OrphanCloseRefusal('lsof returned no open-file snapshot');
  const targets = [input.sourcePath, input.candidatePath].map((target) => path.resolve(target));
  let helperObserved = false;
  let pid: number | null = null;
  let name = 'process';
  let hasCommand = false;
  let hasFile = false;
  let namedFile = false;
  let fileType = '';
  const pathlessKernelTypes = new Set(['PIPE', 'NPOLICY', 'NEXUS']);
  const checkComplete = () => {
    if (pid !== null && (!hasCommand || !hasFile || !namedFile)) {
      throw new OrphanCloseRefusal('lsof returned incomplete open-file protocol');
    }
  };
  for (const line of files.split('\n')) {
    if (!line) continue;
    if (line.startsWith('p')) {
      checkComplete();
      hasCommand = hasFile = namedFile = false;
      pid = Number(line.slice(1));
      name = 'process';
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new OrphanCloseRefusal('lsof returned malformed process identity');
    } else if (line.startsWith('c')) {
      if (pid === null || hasCommand || hasFile || !line.slice(1)) throw new OrphanCloseRefusal('lsof returned malformed command coverage');
      hasCommand = true;
      name = processName(line.slice(1));
    } else if (line.startsWith('f')) {
      if (!hasCommand || !line.slice(1) || (hasFile && !namedFile)) throw new OrphanCloseRefusal('lsof returned incomplete file coverage');
      hasFile = true;
      namedFile = false;
      fileType = '';
    } else if (line.startsWith('t')) {
      if (!hasFile || namedFile || fileType || !line.slice(1)) throw new OrphanCloseRefusal('lsof returned malformed file type coverage');
      fileType = line.slice(1);
    } else if (line.startsWith('n')) {
      if (pid === null || !hasFile || namedFile || (!line.slice(1) && !pathlessKernelTypes.has(fileType))) throw new OrphanCloseRefusal('lsof returned an unbound open file');
      namedFile = true;
      // These native kernel objects have no filesystem namespace. An empty
      // regular/unknown file name still refuses rather than hiding a holder.
      const file = line.slice(1).replace(/ \(deleted\)$/, '');
      if (targets.some((target) => file === target || file.startsWith(target + path.sep))) {
        if (isHelper?.(pid)) helperObserved = true;
        else throw new OrphanCloseRefusal(`live process PID ${pid} (${name}) has an open file or cwd in the worktree`);
      }
    } else {
      throw new OrphanCloseRefusal('lsof returned unexpected open-file protocol');
    }
  }
  checkComplete();
  if (pid === null) throw new OrphanCloseRefusal('lsof open-file coverage is uncertain');
  if (isHelper && !helperObserved) throw new OrphanCloseRefusal('lsof did not cover the attested purge helper');
}
