import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LaneRuntime } from '@/lib/lane/types';

const execFileAsync = promisify(execFile);

const RUNTIME_BINARY_NAMES: Record<LaneRuntime, string[]> = {
  codex: ['codex'],
  gemini: ['gemini'],
  antigravity: ['agy', 'antigravity'],
  opencode: ['opencode'],
  openhands: ['openhands'],
  goose: ['goose'],
  qwen: ['qwen'],
  qoder: ['qodercli'],
  kimi: ['kimi'],
  aider: ['aider'],
  cursor: ['cursor-agent'],
  grok: ['grok'],
  pi: ['pi'],
  'prime-agent': ['prime-agent'],
  'claude-code': ['claude', 'claude-code'],
};

const JS_RUNTIME_WRAPPERS = new Set(['env', 'node', 'bun', 'deno', 'npm', 'npx', 'pnpm', 'yarn']);

export interface RuntimeProcessOwner {
  runtime: LaneRuntime;
  pid: number;
  cwd: string;
  binaryPath: string;
}

interface ProcessCwdRow {
  pid: number;
  cwd: string;
  commandName?: string;
}

interface ProcessCommandRow {
  pid: number;
  command: string;
  binaryPath: string;
}

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

function stripTrailingSlash(value: string): string {
  const parsed = path.resolve(expandHome(value));
  return parsed === path.parse(parsed).root ? parsed : parsed.replace(/\/+$/, '');
}

async function normalizeFsPath(value: string): Promise<string> {
  const resolved = stripTrailingSlash(value);
  return realpath(resolved).then(stripTrailingSlash).catch(() => resolved);
}

function pathWithinWorktree(candidatePath: string, worktreePath: string): boolean {
  const candidate = stripTrailingSlash(candidatePath);
  const worktree = stripTrailingSlash(worktreePath);
  return candidate === worktree || candidate.startsWith(`${worktree}${path.sep}`);
}

function parseLsofCwdOutput(raw: string): ProcessCwdRow[] {
  const rows: ProcessCwdRow[] = [];
  let current: Partial<ProcessCwdRow> = {};

  const flush = () => {
    if (typeof current.pid === 'number' && current.cwd) {
      rows.push(current as ProcessCwdRow);
    }
    current = {};
  };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      flush();
      const pid = Number(value);
      if (Number.isFinite(pid)) current.pid = pid;
    } else if (tag === 'c') {
      current.commandName = value;
    } else if (tag === 'n') {
      current.cwd = value;
    }
  }
  flush();
  return rows;
}

async function readProcessCwds(): Promise<ProcessCwdRow[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-d', 'cwd', '-F', 'pcn'], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 3_000,
    });
    return parseLsofCwdOutput(stdout);
  } catch {
    return [];
  }
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/, 1)[0] ?? '';
}

function commandTokens(command: string): string[] {
  const tokens = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return tokens.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function binaryName(value: string): string {
  return path.basename(value).replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase();
}

function runtimeForBinaryName(name: string): LaneRuntime | null {
  for (const [runtime, names] of Object.entries(RUNTIME_BINARY_NAMES) as Array<[LaneRuntime, string[]]>) {
    if (names.includes(name)) return runtime;
  }
  return null;
}

function runtimeForCommand(command: string, fallbackName?: string): LaneRuntime | null {
  const firstToken = firstCommandToken(command);
  const direct = runtimeForBinaryName(binaryName(firstToken || fallbackName || ''));
  if (direct) return direct;

  const tokens = commandTokens(command);
  const firstName = binaryName(tokens[0] ?? fallbackName ?? '');
  if (!JS_RUNTIME_WRAPPERS.has(firstName)) return null;

  for (const token of tokens.slice(1, 5)) {
    if (!token || token.startsWith('-') || /^[A-Z_][A-Z0-9_]*=/.test(token)) continue;
    const runtime = runtimeForBinaryName(binaryName(token));
    if (runtime) return runtime;
  }
  return null;
}

function parsePsCommandOutput(raw: string): Map<number, ProcessCommandRow> {
  const rows = new Map<number, ProcessCommandRow>();
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2]?.trim() ?? '';
    if (!Number.isFinite(pid) || !command) continue;
    rows.set(pid, {
      pid,
      command,
      binaryPath: firstCommandToken(command),
    });
  }
  return rows;
}

async function readProcessCommands(): Promise<Map<number, ProcessCommandRow>> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 3_000,
    });
    return parsePsCommandOutput(stdout);
  } catch {
    return new Map();
  }
}

export async function listRuntimeProcessesForWorktree(worktreePath: string): Promise<RuntimeProcessOwner[]> {
  const normalizedWorktree = await normalizeFsPath(worktreePath);
  const [cwdRows, commandRows] = await Promise.all([
    readProcessCwds(),
    readProcessCommands(),
  ]);

  const owners: RuntimeProcessOwner[] = [];
  for (const row of cwdRows) {
    if (!pathWithinWorktree(row.cwd, normalizedWorktree)) continue;

    const command = commandRows.get(row.pid);
    const commandText = command?.command ?? row.commandName ?? '';
    const runtime = runtimeForCommand(commandText, row.commandName);
    if (!runtime) continue;

    owners.push({
      runtime,
      pid: row.pid,
      cwd: row.cwd,
      binaryPath: command?.binaryPath ?? row.commandName ?? '',
    });
  }

  return owners.sort((left, right) => right.pid - left.pid);
}

export async function getRuntimeProcessForWorktree(worktreePath: string | null | undefined): Promise<RuntimeProcessOwner | null> {
  const target = worktreePath?.trim();
  if (!target) return null;
  const owners = await listRuntimeProcessesForWorktree(target);
  return owners[0] ?? null;
}

export async function getRuntimeForWorktree(worktreePath: string | null | undefined): Promise<LaneRuntime | null> {
  return getRuntimeProcessForWorktree(worktreePath).then((owner) => owner?.runtime ?? null);
}
