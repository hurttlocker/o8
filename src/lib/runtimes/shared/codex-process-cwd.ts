import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const INDEX_TTL_MS = 2_000;

export interface LiveCodexProcess {
  pid: number;
  parentPid?: number;
  command?: string;
  cwd?: string;
}

type ProcessReader = () => Promise<LiveCodexProcess[]>;

let processReader: ProcessReader | null = null;
let cachedIndex: { builtAt: number; byCwd: Map<string, LiveCodexProcess> } | null = null;

function normalizeCwd(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed).replace(/\/+$/, '');
}

function commandLooksLikeCodex(command: string): boolean {
  const [first, second] = command.trim().split(/\s+/, 2);
  const firstBase = first ? path.basename(first) : '';
  const secondBase = second ? path.basename(second) : '';
  const isCodexToken = (value: string) => value === 'codex' || value.startsWith('codex.');
  return isCodexToken(firstBase) || (firstBase === 'node' && isCodexToken(secondBase));
}

async function readCodexProcessRows(): Promise<LiveCodexProcess[]> {
  let psOut = '';
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=', '-o', 'ppid=', '-o', 'command='],
      { windowsHide: true, maxBuffer: 512 * 1024, timeout: 3000 },
    );
    psOut = stdout;
  } catch {
    return [];
  }

  const rows: LiveCodexProcess[] = [];
  for (const line of psOut.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match?.[1] || !match[3]) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!Number.isFinite(pid) || !commandLooksLikeCodex(match[3])) continue;
    rows.push({
      pid,
      parentPid: Number.isFinite(parentPid) ? parentPid : undefined,
      command: match[3],
    });
  }
  if (rows.length === 0) return [];

  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-a', '-p', rows.map((row) => row.pid).join(','), '-d', 'cwd', '-Fn'],
      { windowsHide: true, maxBuffer: 512 * 1024, timeout: 4000 },
    );
    let currentPid: number | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = Number(line.slice(1));
      } else if (line.startsWith('n/') && currentPid !== null) {
        const row = rows.find((candidate) => candidate.pid === currentPid);
        if (row) row.cwd = line.slice(1);
      }
    }
  } catch {
    // CWD lookup is best-effort; callers only treat a positive CWD match as live.
  }

  return rows;
}

async function buildIndex(now: number): Promise<Map<string, LiveCodexProcess>> {
  if (cachedIndex && now - cachedIndex.builtAt < INDEX_TTL_MS) {
    return cachedIndex.byCwd;
  }

  const reader = processReader ?? readCodexProcessRows;
  const byCwd = new Map<string, LiveCodexProcess>();
  const processes = await reader();
  for (const proc of processes) {
    const cwd = normalizeCwd(proc.cwd);
    if (!cwd || byCwd.has(cwd)) continue;
    byCwd.set(cwd, proc);
  }

  cachedIndex = { builtAt: now, byCwd };
  return byCwd;
}

export async function findLiveCodexProcessByCwd(
  cwd: string | null | undefined,
  now: number = Date.now(),
): Promise<LiveCodexProcess | null> {
  const normalized = normalizeCwd(cwd);
  if (!normalized) return null;
  const index = await buildIndex(now);
  return index.get(normalized) ?? null;
}

export function resetCodexProcessCwdIndexForTesting(): void {
  cachedIndex = null;
  processReader = null;
}

export function setCodexProcessReaderForTesting(reader: ProcessReader): void {
  cachedIndex = null;
  processReader = reader;
}
