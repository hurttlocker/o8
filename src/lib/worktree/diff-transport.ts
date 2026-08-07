import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { isSafeGitRef } from '@/lib/git/refs';

const execFileAsync = promisify(execFile);
const METADATA_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export const SELECTED_DIFF_MAX_BYTES = 512 * 1024;
export const FULL_DIFF_MAX_BYTES = 4 * 1024 * 1024;

export type WorktreeDiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface WorktreeDiffFile {
  path: string;
  additions: number;
  deletions: number;
  status: WorktreeDiffFileStatus;
}

interface InternalDiffFile extends WorktreeDiffFile {
  originalPath?: string;
}

export interface WorktreeDiffSnapshot {
  headSha: string;
  revision: string;
  against: string;
  files: WorktreeDiffFile[];
  additions: number;
  deletions: number;
  untrackedPaths: Set<string>;
}

export interface BoundedDiffBody {
  diff: string;
  sizeBytes: number;
  sizeBytesExact: boolean;
  maxBytes: number;
  truncated: boolean;
}

export class WorktreeHeadChangedError extends Error {
  readonly expectedHeadSha: string | null;
  readonly currentHeadSha: string;

  constructor(expectedHeadSha: string | null, currentHeadSha: string) {
    super('head_changed');
    this.name = 'WorktreeHeadChangedError';
    this.expectedHeadSha = expectedHeadSha;
    this.currentHeadSha = currentHeadSha;
  }
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error || 'unknown git error');
}

async function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout,
    maxBuffer: METADATA_MAX_BUFFER,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}

async function readHeadSha(cwd: string): Promise<string> {
  return (await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])).trim();
}

async function resolveComparison(cwd: string, baseBranch: string | null, headSha: string): Promise<string> {
  const base = baseBranch?.trim();
  if (!base || !isSafeGitRef(base)) return headSha;

  try {
    const mergeBase = (await runGit(cwd, ['merge-base', '--', base, headSha])).trim();
    return mergeBase || headSha;
  } catch {
    // Legacy callers historically fell back to dirty-tree-only when the base
    // ref was unavailable. Keep that behavior without ever treating the ref
    // as a git option.
    return headSha;
  }
}

function statusFromGit(token: string): WorktreeDiffFileStatus {
  switch (token[0]) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R':
    case 'C': return 'renamed';
    default: return 'modified';
  }
}

function parseNameStatusZ(raw: string): Map<string, InternalDiffFile> {
  const fields = raw.split('\0');
  const files = new Map<string, InternalDiffFile>();

  for (let index = 0; index < fields.length;) {
    const statusToken = fields[index++];
    if (!statusToken) continue;
    const firstPath = fields[index++] ?? '';
    if (!firstPath) continue;

    const renamed = statusToken[0] === 'R' || statusToken[0] === 'C';
    const reviewPath = renamed ? (fields[index++] ?? '') : firstPath;
    if (!reviewPath) continue;

    files.set(reviewPath, {
      path: reviewPath,
      status: statusFromGit(statusToken),
      additions: 0,
      deletions: 0,
      ...(renamed ? { originalPath: firstPath } : {}),
    });
  }

  return files;
}

function parseNumstatZ(raw: string): Map<string, { additions: number; deletions: number }> {
  const fields = raw.split('\0');
  const stats = new Map<string, { additions: number; deletions: number }>();

  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;

    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    let reviewPath = inlinePath;

    // With -z, rename/copy records end the numeric prefix at the second tab,
    // then carry old and new paths as two additional NUL-delimited fields.
    if (!inlinePath) {
      index += 1; // old path
      reviewPath = fields[index++] ?? '';
    }
    if (!reviewPath) continue;

    stats.set(reviewPath, {
      additions: additionsRaw === '-' ? 0 : Number.parseInt(additionsRaw, 10) || 0,
      deletions: deletionsRaw === '-' ? 0 : Number.parseInt(deletionsRaw, 10) || 0,
    });
  }

  return stats;
}

async function countUntrackedAdditions(cwd: string, filePath: string): Promise<number> {
  const absolutePath = path.resolve(cwd, filePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) return readlinkSync(absolutePath).length > 0 ? 1 : 0;
  if (!stat.isFile() || stat.size === 0) return 0;

  let newlines = 0;
  let lastByte = -1;
  let binary = false;
  for await (const chunk of createReadStream(absolutePath)) {
    const bytes = chunk as Buffer;
    for (const byte of bytes) {
      if (byte === 0) binary = true;
      if (byte === 10) newlines += 1;
    }
    if (bytes.length > 0) lastByte = bytes[bytes.length - 1];
  }
  if (binary) return 0;
  return newlines + (lastByte === 10 ? 0 : 1);
}

async function revisionForSnapshot(
  cwd: string,
  headSha: string,
  against: string,
  files: InternalDiffFile[],
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`${headSha}\0${against}\0`);

  for (const file of files) {
    hash.update(`${file.path}\0${file.originalPath ?? ''}\0${file.status}\0${file.additions}\0${file.deletions}\0`);
    try {
      const stat = lstatSync(path.resolve(cwd, file.path), { bigint: true });
      hash.update(`${stat.size}:${stat.mtimeNs}:${stat.mode}\0`);
    } catch {
      hash.update('missing\0');
    }
  }

  return hash.digest('hex');
}

async function collectSnapshotOnce(
  cwd: string,
  baseBranch: string | null,
  expectedHeadSha: string | null,
): Promise<WorktreeDiffSnapshot> {
  const headSha = await readHeadSha(cwd);
  if (expectedHeadSha && expectedHeadSha !== headSha) {
    throw new WorktreeHeadChangedError(expectedHeadSha, headSha);
  }

  const against = await resolveComparison(cwd, baseBranch, headSha);
  const diffArgs = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--find-renames', against];
  const [nameStatusRaw, numstatRaw, untrackedRaw] = await Promise.all([
    runGit(cwd, [...diffArgs, '--name-status', '-z', '--']),
    runGit(cwd, [...diffArgs, '--numstat', '-z', '--']),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ]);

  const filesByPath = parseNameStatusZ(nameStatusRaw);
  const statsByPath = parseNumstatZ(numstatRaw);
  for (const [filePath, stat] of statsByPath) {
    const file = filesByPath.get(filePath) ?? {
      path: filePath,
      status: 'modified' as const,
      additions: 0,
      deletions: 0,
    };
    file.additions = stat.additions;
    file.deletions = stat.deletions;
    filesByPath.set(filePath, file);
  }

  const untrackedPaths = new Set(untrackedRaw.split('\0').filter(Boolean));
  const queuedUntrackedPaths = Array.from(untrackedPaths);
  let nextUntrackedIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(8, queuedUntrackedPaths.length) },
    async () => {
      while (nextUntrackedIndex < queuedUntrackedPaths.length) {
        const filePath = queuedUntrackedPaths[nextUntrackedIndex++];
        const additions = await countUntrackedAdditions(cwd, filePath).catch(() => 0);
        filesByPath.set(filePath, {
          path: filePath,
          status: 'untracked',
          additions,
          deletions: 0,
        });
      }
    },
  ));

  const internalFiles = Array.from(filesByPath.values())
    .sort((left, right) => left.path.localeCompare(right.path));
  const revision = await revisionForSnapshot(cwd, headSha, against, internalFiles);
  const currentHeadSha = await readHeadSha(cwd);
  if (currentHeadSha !== headSha) {
    throw new WorktreeHeadChangedError(expectedHeadSha ?? headSha, currentHeadSha);
  }

  const files = internalFiles.map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));
  return {
    headSha,
    revision,
    against,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    untrackedPaths,
  };
}

export async function collectWorktreeDiffSnapshot(
  cwd: string,
  baseBranch: string | null,
  expectedHeadSha: string | null = null,
): Promise<WorktreeDiffSnapshot> {
  try {
    return await collectSnapshotOnce(cwd, baseBranch, expectedHeadSha);
  } catch (error) {
    if (!(error instanceof WorktreeHeadChangedError) || expectedHeadSha) throw error;
    return collectSnapshotOnce(cwd, baseBranch, null);
  }
}

export function validateRepoRelativePath(rawPath: string): string {
  if (!rawPath || rawPath.length > 4096 || rawPath.includes('\0')) {
    throw new Error('invalid_file_path');
  }
  if (path.posix.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath) || rawPath.includes('\\')) {
    throw new Error('invalid_file_path');
  }

  const segments = rawPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('invalid_file_path');
  }
  if (path.posix.normalize(rawPath) !== rawPath) throw new Error('invalid_file_path');
  return rawPath;
}

export function parseDiffMaxBytes(raw: string | null, defaultBytes: number, hardMaxBytes: number): number {
  if (!raw) return defaultBytes;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultBytes;
  return Math.min(parsed, hardMaxBytes);
}

class DiffAccumulator {
  readonly maxBytes: number;
  private chunks: Buffer[] = [];
  private storedBytes = 0;
  sizeBytes = 0;
  truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  append(value: Buffer | string): void {
    const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    this.sizeBytes += chunk.length;
    const remaining = this.maxBytes - this.storedBytes;
    if (remaining > 0) {
      const stored = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      this.chunks.push(stored);
      this.storedBytes += stored.length;
    }
    if (chunk.length > remaining) this.truncated = true;
  }

  toUtf8(): string {
    const value = Buffer.concat(this.chunks);
    if (!this.truncated || value.length === 0) return value.toString('utf8');

    const marker = Buffer.from(`\n[diff truncated at ${this.maxBytes} bytes]\n`, 'utf8');
    if (marker.length >= this.maxBytes) return marker.subarray(0, this.maxBytes).toString('utf8');
    const boundedValue = value.subarray(0, this.maxBytes - marker.length);

    // Avoid ending the bounded response in the middle of a UTF-8 code point.
    let sequenceStart = boundedValue.length - 1;
    while (sequenceStart >= 0 && (boundedValue[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1;
    if (sequenceStart >= 0) {
      const lead = boundedValue[sequenceStart];
      const expectedLength = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (boundedValue.length - sequenceStart < expectedLength) {
        return `${boundedValue.subarray(0, sequenceStart).toString('utf8')}${marker.toString('utf8')}`;
      }
    }
    return `${boundedValue.toString('utf8')}${marker.toString('utf8')}`;
  }
}

async function appendGitDiff(
  cwd: string,
  args: string[],
  accumulator: DiffAccumulator,
  allowedExitCodes: number[] = [0],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      windowsHide: true,
      cwd,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let stoppedAtLimit = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      accumulator.append(chunk);
      if (accumulator.truncated && !stoppedAtLimit) {
        stoppedAtLimit = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('git_diff_timeout'));
        return;
      }
      if (stoppedAtLimit) {
        resolve();
        return;
      }
      if (code !== null && allowedExitCodes.includes(code)) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `git diff exited ${code ?? 'without a status'}`));
    });
  });
}

export async function collectBoundedDiffBody(
  cwd: string,
  snapshot: WorktreeDiffSnapshot,
  filePath: string | null,
  maxBytes: number,
): Promise<BoundedDiffBody> {
  const currentHeadSha = await readHeadSha(cwd);
  if (currentHeadSha !== snapshot.headSha) {
    throw new WorktreeHeadChangedError(snapshot.headSha, currentHeadSha);
  }

  const accumulator = new DiffAccumulator(maxBytes);
  const trackedArgs = [
    '--literal-pathspecs',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
    snapshot.against,
    '--',
    ...(filePath ? [filePath] : []),
  ];

  if (filePath && snapshot.untrackedPaths.has(filePath)) {
    await appendGitDiff(
      cwd,
      ['--literal-pathspecs', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', filePath],
      accumulator,
      [0, 1],
    );
  } else {
    await appendGitDiff(cwd, trackedArgs, accumulator);
    if (!filePath) {
      for (const untrackedPath of snapshot.untrackedPaths) {
        if (accumulator.truncated) break;
        if (accumulator.sizeBytes > 0) accumulator.append('\n');
        if (accumulator.truncated) break;
        await appendGitDiff(
          cwd,
          ['--literal-pathspecs', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', untrackedPath],
          accumulator,
          [0, 1],
        );
      }
    }
  }

  const finalHeadSha = await readHeadSha(cwd);
  if (finalHeadSha !== snapshot.headSha) {
    throw new WorktreeHeadChangedError(snapshot.headSha, finalHeadSha);
  }

  return {
    diff: accumulator.toUtf8(),
    sizeBytes: accumulator.sizeBytes,
    sizeBytesExact: !accumulator.truncated,
    maxBytes,
    truncated: accumulator.truncated,
  };
}

export function worktreeDiffErrorMessage(error: unknown): string {
  return gitErrorMessage(error);
}
