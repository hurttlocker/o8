import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { purgeExactDirectory } from './exact-directory-purge';

const execFileAsync = promisify(execFile);

export interface DestructiveDirectoryIdentity {
  repoPath: string;
  expectedPath: string;
  canonicalPath: string;
  managedBase: string;
  canonicalManagedBase: string;
  entries: Array<{
    candidate: string;
    canonicalPath: string;
    device: number;
    inode: number;
    kind: 'directory' | 'symlink';
  }>;
}

export interface GitWorktreeAdminIdentity {
  path: string;
  device: number;
  inode: number;
  markerPath: string;
  markerDevice: number;
  markerInode: number;
  markerContents: string;
}

export interface GitWorktreeAdminReceipt {
  gitAdminPath: string | null;
  gitAdminDevice: number | null;
  gitAdminInode: number | null;
}

function lexicalAncestors(candidate: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(candidate);
  for (;;) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

export async function captureDestructiveDirectoryIdentity(
  repoPath: string,
  expectedPath: string,
): Promise<DestructiveDirectoryIdentity> {
  const managedBase = resolveWorktreeRootLayout(repoPath).bases
    .map((base) => path.resolve(base))
    .find((base) => path.dirname(expectedPath) === base);
  if (!managedBase) throw new Error('Exact parking destructive boundary lost its managed root.');
  const candidates = [expectedPath, ...lexicalAncestors(managedBase)];
  const entries = await Promise.all(candidates.map(async (candidate, index) => {
    const stat = await lstat(candidate);
    const kind: 'directory' | 'symlink' | null = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory() ? 'directory' : null;
    if (!kind || (index === 0 && kind !== 'directory')) {
      throw new Error('Exact parking destructive boundary requires a regular directory, never a symlink.');
    }
    return {
      candidate,
      canonicalPath: await realpath(candidate),
      device: stat.dev,
      inode: stat.ino,
      kind,
    };
  }));
  const canonicalPath = entries[0]!.canonicalPath;
  const canonicalManagedBase = entries[1]!.canonicalPath;
  if (path.dirname(canonicalPath) !== canonicalManagedBase) {
    throw new Error('Exact parking canonical path escapes its managed worktree root.');
  }
  return { repoPath, expectedPath, canonicalPath, managedBase, canonicalManagedBase, entries };
}

export async function verifyDestructiveDirectoryIdentity(
  captured: DestructiveDirectoryIdentity,
): Promise<void> {
  const current = await captureDestructiveDirectoryIdentity(
    captured.repoPath,
    captured.expectedPath,
  ).catch(() => null);
  if (!current
    || current.managedBase !== captured.managedBase
    || current.canonicalManagedBase !== captured.canonicalManagedBase
    || current.canonicalPath !== captured.canonicalPath
    || current.entries.length !== captured.entries.length
    || current.entries.some((entry, index) => {
      const prior = captured.entries[index];
      return !prior
        || entry.candidate !== prior.candidate
        || entry.canonicalPath !== prior.canonicalPath
        || entry.device !== prior.device
        || entry.inode !== prior.inode
        || entry.kind !== prior.kind;
    })) {
    throw new Error('Exact parking destructive path identity changed before removal.');
  }
}

export async function captureGitWorktreeAdminIdentity(
  repoPath: string,
  workspacePath: string,
  hooks?: { afterMarkerLstat?: () => Promise<void>; afterMarkerRead?: () => Promise<void> },
): Promise<GitWorktreeAdminIdentity> {
  const markerPath = path.join(await realpath(workspacePath), '.git');
  const markerBefore = await lstat(markerPath);
  if (!markerBefore.isFile() || markerBefore.isSymbolicLink()) {
    throw new Error('Exact Git worktree marker is not a regular file.');
  }
  await hooks?.afterMarkerLstat?.();
  const markerContents = await readFile(markerPath, 'utf8');
  await hooks?.afterMarkerRead?.();
  const markerAfter = await lstat(markerPath);
  if (!markerAfter.isFile() || markerAfter.isSymbolicLink()
    || markerBefore.dev !== markerAfter.dev || markerBefore.ino !== markerAfter.ino
    || markerBefore.size !== markerAfter.size || markerBefore.mtimeMs !== markerAfter.mtimeMs) {
    throw new Error('Exact Git worktree marker identity changed during capture.');
  }
  const match = /^gitdir:\s*(.+)\s*$/i.exec(markerContents);
  if (!match?.[1]) throw new Error('Exact Git worktree marker is invalid.');
  const adminPath = path.resolve(workspacePath, match[1]);
  const [adminStat, gitDir, adminMarker] = await Promise.all([
    lstat(adminPath),
    execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
      windowsHide: true, cwd: repoPath, timeout: 5_000,
    }).then(({ stdout }) => path.resolve(stdout.trim())),
    readFile(path.join(adminPath, 'gitdir'), 'utf8'),
  ]);
  if (!adminStat.isDirectory() || adminStat.isSymbolicLink()) {
    throw new Error('Exact Git worktree admin entry is not a regular directory.');
  }
  const expectedAdminRoot = path.join(await realpath(gitDir), 'worktrees');
  if (path.dirname(await realpath(adminPath)) !== expectedAdminRoot) {
    throw new Error('Exact Git worktree admin entry escapes the registered object store.');
  }
  if (path.resolve(adminPath, adminMarker.trim()) !== path.resolve(markerPath)) {
    throw new Error('Exact Git worktree admin entry belongs to a different workspace marker.');
  }
  return {
    path: adminPath,
    device: adminStat.dev,
    inode: adminStat.ino,
    markerPath: path.resolve(markerPath),
    markerDevice: markerAfter.dev,
    markerInode: markerAfter.ino,
    markerContents,
  };
}

export async function verifyGitWorktreeAdminIdentity(
  repoPath: string,
  workspacePath: string,
  expected: GitWorktreeAdminIdentity,
): Promise<void> {
  const current = await captureGitWorktreeAdminIdentity(repoPath, workspacePath);
  if (current.path !== expected.path || current.device !== expected.device
    || current.inode !== expected.inode || current.markerPath !== expected.markerPath
    || current.markerDevice !== expected.markerDevice || current.markerInode !== expected.markerInode
    || current.markerContents !== expected.markerContents) {
    throw new Error('Exact Git worktree marker and admin association changed before parking.');
  }
}

/** Recover only the unique shared-admin row whose stable backlink names this workspace marker. */
export async function recoverGitWorktreeAdminReceipt(
  repoPath: string,
  workspacePath: string,
): Promise<GitWorktreeAdminReceipt> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
    windowsHide: true, cwd: repoPath, timeout: 5_000,
  });
  const adminRoot = path.join(await realpath(path.resolve(stdout.trim())), 'worktrees');
  const names = await readdir(adminRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const markerPath = path.join(await realpath(workspacePath), '.git');
  const matches: GitWorktreeAdminReceipt[] = [];
  for (const name of names) {
    const adminPath = path.join(adminRoot, name);
    const before = await lstat(adminPath).catch(() => null);
    if (!before?.isDirectory() || before.isSymbolicLink()) continue;
    const backlinkPath = path.join(adminPath, 'gitdir');
    const backlinkBefore = await lstat(backlinkPath).catch(() => null);
    if (!backlinkBefore?.isFile() || backlinkBefore.isSymbolicLink()) continue;
    const backlink = await readFile(backlinkPath, 'utf8').catch(() => null);
    const [backlinkAfter, adminAfter] = await Promise.all([
      lstat(backlinkPath).catch(() => null),
      lstat(adminPath).catch(() => null),
    ]);
    if (!backlink || !backlinkAfter?.isFile() || backlinkAfter.isSymbolicLink()
      || !adminAfter?.isDirectory() || adminAfter.isSymbolicLink()
      || backlinkBefore.dev !== backlinkAfter.dev || backlinkBefore.ino !== backlinkAfter.ino
      || backlinkBefore.size !== backlinkAfter.size || backlinkBefore.mtimeMs !== backlinkAfter.mtimeMs
      || before.dev !== adminAfter.dev || before.ino !== adminAfter.ino
      || path.resolve(adminPath, backlink.trim()) !== markerPath
      || path.dirname(await realpath(adminPath)) !== adminRoot) continue;
    matches.push({
      gitAdminPath: adminPath,
      gitAdminDevice: adminAfter.dev,
      gitAdminInode: adminAfter.ino,
    });
  }
  if (matches.length > 1) {
    throw new Error('Exact restore found multiple shared Git-admin rows for one target.');
  }
  return matches[0] ?? { gitAdminPath: null, gitAdminDevice: null, gitAdminInode: null };
}

export async function cleanupExactGitWorktreeAdmin(
  repoPath: string,
  receipt: GitWorktreeAdminReceipt,
): Promise<void> {
  if (!receipt.gitAdminPath) return;
  const adminStat = await lstat(receipt.gitAdminPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!adminStat) return;
  const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
    windowsHide: true, cwd: repoPath, timeout: 5_000,
  });
  const adminRoot = path.join(await realpath(path.resolve(stdout.trim())), 'worktrees');
  if (!adminStat.isDirectory()
    || adminStat.isSymbolicLink()
    || adminStat.dev !== receipt.gitAdminDevice
    || adminStat.ino !== receipt.gitAdminInode
    || path.dirname(await realpath(receipt.gitAdminPath)) !== adminRoot) {
    throw new Error('Exact Git worktree admin identity changed before cleanup.');
  }
  await purgeExactDirectory(receipt.gitAdminPath, {
    device: receipt.gitAdminDevice,
    inode: receipt.gitAdminInode,
  });
}
