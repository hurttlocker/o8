import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolvePacketDiffBase, type PacketDiffBaseResolution } from '@/lib/diff/base-resolution';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { resolveLaneReviewTarget } from '@/lib/lane/review-target';
import type { Lane } from '@/lib/lane/types';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 32 * 1024 * 1024;

export interface LaneDiffFacts {
  changedFiles: string[];
  fileChanges: LaneFileChange[];
  addedLines: string[];
}

export interface LaneSpokenDiffFacts extends LaneDiffFacts {
  headSha: string;
  against: string;
  diffBase: PacketDiffBaseResolution;
  stat: string;
  fingerprint: string;
  snapshotTreeHash: string;
  dirtyFiles: string[];
  untrackedFiles: string[];
}

export type LaneFileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface LaneFileChange {
  path: string;
  status: LaneFileChangeStatus;
  previousPath?: string;
}

export function extractAddedLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
}

/** Parse `git diff --stat` output into per-file insertion/deletion counts. */
export function parseDiffStat(stat: string): Array<{ file: string; insertions: number; deletions: number }> {
  const results: Array<{ file: string; insertions: number; deletions: number }> = [];
  for (const line of stat.split('\n')) {
    // Format: " src/foo.ts | 42 +++++-----"  or  " src/foo.ts | 10 ++++"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s/);
    if (!match) continue;
    const file = match[1].trim();
    const plusMatch = line.match(/(\d+)\s*insertion/);
    const minusMatch = line.match(/(\d+)\s*deletion/);
    // Fallback: count + and - symbols in the bar chart
    const barMatch = line.match(/\|\s*\d+\s+([\s+\-]+)$/);
    let insertions = plusMatch ? parseInt(plusMatch[1], 10) : 0;
    let deletions = minusMatch ? parseInt(minusMatch[1], 10) : 0;
    if (!plusMatch && !minusMatch && barMatch) {
      const bar = barMatch[1];
      insertions = (bar.match(/\+/g) || []).length;
      deletions = (bar.match(/-/g) || []).length;
    }
    if (file && (insertions > 0 || deletions > 0)) {
      results.push({ file, insertions, deletions });
    }
  }
  return results;
}

export function parseNameStatus(output: string): LaneFileChange[] {
  const tokens = output.split('\0');
  const changes: LaneFileChange[] = [];

  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++]?.trim();
    if (!rawStatus) continue;
    const statusCode = rawStatus[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const previousPath = tokens[index++] ?? '';
      const path = tokens[index++] ?? '';
      if (path) {
        changes.push({ path, previousPath: previousPath || undefined, status: 'renamed' });
      }
      continue;
    }

    const path = tokens[index++] ?? '';
    if (!path) continue;
    const status: LaneFileChangeStatus = statusCode === 'A'
      ? 'added'
      : statusCode === 'D'
        ? 'deleted'
        : 'modified';
    changes.push({ path, status });
  }

  return changes;
}

function readGitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd,
    timeout: 10_000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

async function readGitOutputAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout: 10_000,
    encoding: 'utf-8',
    maxBuffer: COMMAND_MAX_BUFFER,
  });
  return stdout;
}

function parseUntrackedFiles(output: string): LaneFileChange[] {
  return output
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, status: 'untracked' as const }));
}

async function hashUntrackedFiles(cwd: string, paths: string[]): Promise<string[]> {
  if (paths.length > 500) {
    throw new Error(`Spoken review refused ${paths.length} untracked files; clean or commit the worktree first.`);
  }
  const hashes: string[] = [];
  for (const path of paths) {
    const hash = await readGitOutputAsync(cwd, ['hash-object', '--no-filters', '--', path]);
    hashes.push(`${path}\0${hash.trim()}`);
  }
  return hashes;
}

async function readWorktreeTreeHash(cwd: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'o8-spoken-review-index-'));
  const indexPath = join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await execFileAsync('git', ['read-tree', 'HEAD'], {
      windowsHide: true,
      cwd,
      env,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    await execFileAsync('git', ['add', '-A', '--', '.'], {
      windowsHide: true,
      cwd,
      env,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const { stdout } = await execFileAsync('git', ['write-tree'], {
      windowsHide: true,
      cwd,
      env,
      timeout: 10_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return stdout.trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function spokenReviewSnapshotFingerprint(
  headSha: string,
  against: string,
  snapshotTreeHash: string,
) {
  return createHash('sha256')
    .update(headSha)
    .update('\0')
    .update(against)
    .update('\0')
    .update(snapshotTreeHash)
    .digest('hex');
}

/**
 * Read the exact evidence used by Symon's spoken packet review.
 *
 * Unlike the legacy synchronous risk helper below, this projection includes
 * committed changes, tracked dirty changes, and untracked paths. It also locks
 * every result to one HEAD and fails closed instead of falling back to an
 * unrelated previous commit.
 */
export async function getLaneSpokenDiffFacts(lane: Lane): Promise<LaneSpokenDiffFacts> {
  const cwd = resolveLaneReviewTarget(lane).cwd;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headSha = await readHeadSha(cwd);
    const diffBase = await resolvePacketDiffBase(cwd, lane.baseBranch || 'main', headSha);
    const against = diffBase.mergeBase ?? diffBase.comparisonRef;
    const [stat, diff, nameStatus, dirtyNameOnly, untracked, snapshotTreeHash] = await Promise.all([
      readGitOutputAsync(cwd, ['diff', '--stat', against]),
      readGitOutputAsync(cwd, ['diff', against, '--no-color', '-U2']),
      readGitOutputAsync(cwd, ['diff', '--name-status', '-z', '--find-renames', against]),
      readGitOutputAsync(cwd, ['diff', '--name-only', '-z', 'HEAD']),
      readGitOutputAsync(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
      readWorktreeTreeHash(cwd),
    ]);
    const untrackedFiles = untracked.split('\0').filter(Boolean);
    const untrackedHashes = await hashUntrackedFiles(cwd, untrackedFiles);
    const currentHeadSha = await readHeadSha(cwd);
    if (currentHeadSha !== headSha) continue;

    const [currentDiff, currentNameStatus, currentDirtyNameOnly, currentUntracked, currentSnapshotTreeHash] = await Promise.all([
      readGitOutputAsync(cwd, ['diff', against, '--no-color', '-U2']),
      readGitOutputAsync(cwd, ['diff', '--name-status', '-z', '--find-renames', against]),
      readGitOutputAsync(cwd, ['diff', '--name-only', '-z', 'HEAD']),
      readGitOutputAsync(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
      readWorktreeTreeHash(cwd),
    ]);
    const currentUntrackedFiles = currentUntracked.split('\0').filter(Boolean);
    const currentUntrackedHashes = await hashUntrackedFiles(cwd, currentUntrackedFiles);
    if (
      currentDiff !== diff
      || currentNameStatus !== nameStatus
      || currentDirtyNameOnly !== dirtyNameOnly
      || currentUntracked !== untracked
      || currentUntrackedHashes.join('\0') !== untrackedHashes.join('\0')
      || currentSnapshotTreeHash !== snapshotTreeHash
    ) continue;

    const trackedChanges = parseNameStatus(nameStatus);
    const trackedPaths = new Set(trackedChanges.map((entry) => entry.path));
    const untrackedChanges = parseUntrackedFiles(untracked)
      .filter((entry) => !trackedPaths.has(entry.path));
    const fileChanges = [...trackedChanges, ...untrackedChanges];

    return {
      headSha,
      against,
      diffBase,
      stat: stat.trim(),
      fingerprint: spokenReviewSnapshotFingerprint(headSha, against, snapshotTreeHash),
      snapshotTreeHash,
      dirtyFiles: dirtyNameOnly.split('\0').filter(Boolean),
      untrackedFiles,
      changedFiles: fileChanges.map((entry) => entry.path),
      fileChanges,
      addedLines: extractAddedLines(diff),
    };
  }

  throw new Error('Worktree HEAD moved while computing spoken review evidence. Retry the review.');
}

function readGitOutputWithFallback(cwd: string, primaryArgs: string[], fallbackArgs: string[]): string {
  try {
    return readGitOutput(cwd, primaryArgs);
  } catch {
    try {
      return readGitOutput(cwd, fallbackArgs);
    } catch {
      return '';
    }
  }
}

export function getLaneDiffFacts(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>,
): LaneDiffFacts {
  const cwd = lane.worktreePath || lane.repoPath;
  if (!cwd) {
    throw new Error('Lane has no repository path for diff facts.');
  }

  const baseRange = `${lane.baseBranch}...HEAD`;
  const stat = readGitOutputWithFallback(
    cwd,
    ['diff', '--stat', baseRange],
    ['diff', '--stat', 'HEAD~1'],
  );
  const diff = readGitOutputWithFallback(
    cwd,
    ['diff', baseRange, '--no-color', '-U2'],
    ['diff', 'HEAD~1', '--no-color', '-U2'],
  );
  const nameStatus = readGitOutputWithFallback(
    cwd,
    ['diff', '--name-status', '-z', baseRange],
    ['diff', '--name-status', '-z', 'HEAD~1'],
  );
  const fileChanges = parseNameStatus(nameStatus);

  return {
    changedFiles: fileChanges.length > 0
      ? fileChanges.map((entry) => entry.path)
      : stat ? parseDiffStat(stat).map((entry) => entry.file) : [],
    fileChanges,
    addedLines: extractAddedLines(diff),
  };
}
