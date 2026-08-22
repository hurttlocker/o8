import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  readProcessCwdsForPids,
  type ProcessCwdExecFile,
} from '@/lib/runtime/process-cwd-snapshot';
import {
  codexShellSnapshotsRoot,
  queryCodexProcessBindings,
  type CodexProcessBinding,
  type CodexThreadRow,
} from './discovery-store';

const execFileAsync = promisify(execFile);

export interface LiveCodexProcess {
  pid: number;
  parentPid?: number;
  tty?: string;
  elapsed?: string;
  command?: string;
  cwd?: string;
  termSessionId?: string;
}

export interface CodexThreadActivity {
  lastLogTs?: number;
  pid?: number;
  tty?: string;
  active: boolean;
}

export interface CodexProcessDiscoveryOptions {
  execFile?: ProcessCwdExecFile;
}

function normalizeFsPath(value?: string | null): string {
  if (!value) return '';
  return path.resolve(value).replace(/\/+$/, '');
}

function parsePidFromProcessUuid(processUuid?: string | null): number | undefined {
  const match = (processUuid ?? '').match(/^pid:(\d+):/);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

async function runProcessCommand(
  file: string,
  args: string[],
  options: Parameters<ProcessCwdExecFile>[2],
  seam?: ProcessCwdExecFile,
) {
  return seam
    ? seam(file, args, options)
    : execFileAsync(file, args, options);
}

async function readProcessTermSessionId(
  pid: number,
  options: CodexProcessDiscoveryOptions,
): Promise<string | undefined> {
  try {
    const { stdout } = await runProcessCommand(
      'ps',
      ['eww', '-p', String(pid), '-o', 'command='],
      { windowsHide: true, maxBuffer: 256 * 1024, timeout: 3_000 },
      options.execFile,
    );
    const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
    return text.match(/(?:^|\s)TERM_SESSION_ID=([^\s]+)/)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function queryLiveCodexProcesses(
  pids: number[],
  options: CodexProcessDiscoveryOptions = {},
): Promise<Map<number, LiveCodexProcess>> {
  const candidatePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (candidatePids.length === 0) return new Map();

  try {
    const { stdout } = await runProcessCommand(
      'ps',
      ['-o', 'pid=', '-o', 'ppid=', '-o', 'tt=', '-o', 'etime=', '-o', 'command=', '-p', candidatePids.join(',')],
      { windowsHide: true, maxBuffer: 512 * 1024, timeout: 3_000 },
      options.execFile,
    );
    const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
    const rows: LiveCodexProcess[] = [];
    for (const line of text.split('\n').map((value) => value.trim()).filter(Boolean)) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid) || !match[5]?.includes('/codex')) continue;
      rows.push({
        pid,
        parentPid: Number(match[2]),
        tty: match[3],
        elapsed: match[4],
        command: match[5],
      });
    }

    const cwdByPid = await readProcessCwdsForPids(
      rows.map((row) => row.pid),
      { execFile: options.execFile },
    );
    const result = new Map<number, LiveCodexProcess>();
    await Promise.all(rows.map(async (row) => {
      result.set(row.pid, {
        ...row,
        cwd: cwdByPid.get(row.pid),
        termSessionId: await readProcessTermSessionId(row.pid, options),
      });
    }));
    return result;
  } catch {
    return new Map();
  }
}

async function buildShellSnapshotSessionMap(
  threadIds: string[],
  codexHome: string,
): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();

  let snapshotFiles: string[];
  try {
    snapshotFiles = await readdir(codexShellSnapshotsRoot(codexHome));
  } catch {
    return new Map();
  }

  const wanted = new Set(threadIds);
  const mapping = new Map<string, string>();
  for (const fileName of snapshotFiles) {
    const [threadId] = fileName.split('.');
    if (!threadId || !wanted.has(threadId) || mapping.has(threadId)) continue;
    try {
      const raw = await readFile(path.join(codexShellSnapshotsRoot(codexHome), fileName), 'utf8');
      const match = raw.match(/^export TERM_SESSION_ID=(.+)$/m);
      if (match?.[1]) mapping.set(threadId, match[1].trim());
    } catch {
      continue;
    }
  }
  return mapping;
}

export async function queryAllLiveCodexProcesses(
  options: CodexProcessDiscoveryOptions = {},
): Promise<Map<number, LiveCodexProcess>> {
  try {
    const { stdout } = await runProcessCommand(
      'ps',
      ['-eo', 'pid=', '-o', 'command='],
      { windowsHide: true, maxBuffer: 256 * 1024, timeout: 3_000 },
      options.execFile,
    );
    const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
    const pids = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('/codex'))
      .map((line) => Number(line.match(/^(\d+)/)?.[1]))
      .filter((pid) => Number.isFinite(pid));
    const allLive = await queryLiveCodexProcesses(pids, options);
    const livePids = new Set(allLive.keys());
    return new Map(
      [...allLive.entries()].filter(([, proc]) => !proc.parentPid || !livePids.has(proc.parentPid)),
    );
  } catch {
    return new Map();
  }
}

export async function buildCodexActivityMap(
  threads: CodexThreadRow[],
  codexHome: string,
  knownLiveProcesses?: Map<number, LiveCodexProcess>,
): Promise<Map<string, CodexThreadActivity>> {
  const byThreadId = new Map<string, CodexThreadActivity>();
  const threadIds = new Set(threads.map((thread) => thread.id));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const bindings = await queryCodexProcessBindings(codexHome);
  const threadSessionIds = await buildShellSnapshotSessionMap([...threadIds], codexHome);
  const allLiveProcesses = knownLiveProcesses ?? await queryAllLiveCodexProcesses();

  const latestBindingByProcess = new Map<string, CodexProcessBinding>();
  for (const binding of bindings) {
    const existing = latestBindingByProcess.get(binding.process_uuid);
    if (!existing || binding.last_ts > existing.last_ts) {
      latestBindingByProcess.set(binding.process_uuid, binding);
    }
    if (threadIds.has(binding.thread_id)) {
      const previous = byThreadId.get(binding.thread_id);
      byThreadId.set(binding.thread_id, {
        ...previous,
        active: previous?.active ?? false,
        lastLogTs: Math.max(previous?.lastLogTs ?? 0, binding.last_ts),
      });
    }
  }

  const livePidBindings = [...latestBindingByProcess.values()]
    .map((binding) => ({ binding, pid: parsePidFromProcessUuid(binding.process_uuid) }))
    .filter((item): item is { binding: CodexProcessBinding; pid: number } => Boolean(item.pid));
  const liveProcesses = await queryLiveCodexProcesses(livePidBindings.map((item) => item.pid));

  for (const { binding, pid } of livePidBindings) {
    if (!threadIds.has(binding.thread_id)) continue;
    const thread = threadById.get(binding.thread_id);
    const liveProcess = liveProcesses.get(pid);
    if (!thread || !liveProcess) continue;
    if (normalizeFsPath(liveProcess.cwd) !== normalizeFsPath(thread.cwd)) continue;
    const previous = byThreadId.get(binding.thread_id);
    byThreadId.set(binding.thread_id, {
      ...previous,
      active: true,
      pid,
      tty: liveProcess.tty,
      lastLogTs: Math.max(previous?.lastLogTs ?? 0, binding.last_ts),
    });
  }

  for (const [threadId, termSessionId] of threadSessionIds) {
    const thread = threadById.get(threadId);
    if (!thread || !termSessionId) continue;
    const proc = [...allLiveProcesses.values()].find((candidate) => (
      candidate.termSessionId === termSessionId
      && normalizeFsPath(candidate.cwd) === normalizeFsPath(thread.cwd)
    ));
    if (!proc) continue;
    const previous = byThreadId.get(threadId);
    byThreadId.set(threadId, {
      ...previous,
      active: true,
      pid: proc.pid,
      tty: proc.tty,
      lastLogTs: Math.max(previous?.lastLogTs ?? 0, thread.updated_at),
    });
  }

  return byThreadId;
}
