import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { readProcessCwdsForPids } from '@/lib/runtime/process-cwd-snapshot';

const execFileAsync = promisify(execFile);
const ACTIVE_INDEX_TTL_MS = 15_000;
const IDLE_INDEX_TTL_MS = 30_000;

export interface LiveCodexProcess {
  pid: number;
  parentPid?: number;
  command?: string;
  cwd?: string;
}

type ProcessReader = () => Promise<LiveCodexProcess[]>;

let processReader: ProcessReader | null = null;
let cachedIndex: { expiresAt: number; byCwd: Map<string, LiveCodexProcess> } | null = null;
let indexInflight: Promise<Map<string, LiveCodexProcess>> | null = null;

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

  const cwdByPid = await readProcessCwdsForPids(rows.map((row) => row.pid));
  for (const row of rows) {
    row.cwd = cwdByPid.get(row.pid);
  }

  return rows;
}

async function buildIndex(now: number): Promise<Map<string, LiveCodexProcess>> {
  if (cachedIndex && now < cachedIndex.expiresAt) {
    return cachedIndex.byCwd;
  }
  if (indexInflight) return indexInflight;

  const promise = (async () => {
    const reader = processReader ?? readCodexProcessRows;
    const byCwd = new Map<string, LiveCodexProcess>();
    const processes = await reader();
    for (const proc of processes) {
      const cwd = normalizeCwd(proc.cwd);
      if (!cwd || byCwd.has(cwd)) continue;
      byCwd.set(cwd, proc);
    }

    cachedIndex = {
      expiresAt: now + (byCwd.size > 0 ? ACTIVE_INDEX_TTL_MS : IDLE_INDEX_TTL_MS),
      byCwd,
    };
    return byCwd;
  })();
  indexInflight = promise;
  try {
    return await promise;
  } finally {
    if (indexInflight === promise) indexInflight = null;
  }
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
  indexInflight = null;
  processReader = null;
}

export function setCodexProcessReaderForTesting(reader: ProcessReader): void {
  cachedIndex = null;
  indexInflight = null;
  processReader = reader;
}
