import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { observeStorageVolume } from '@/lib/workspace/storage-admission';
import type { StorageRootIdentity } from '@/lib/workspace/storage-admission';
import { ensurePinnedWorkspaceDirectory } from './materialization-leaf-io';

export const LEGACY_WORKTREE_DIR_NAME = '.cortex-worktrees';
export const WORKTREE_ROOT_ENV = 'O8_WORKTREE_ROOT';

export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync.native(repoRoot);
  } catch {
    return path.resolve(repoRoot);
  }
}

/** Stable, human-readable key that prevents same-named repos from colliding. */
export function worktreeRepoKey(repoRoot: string): string {
  const canonical = canonicalRepoRoot(repoRoot);
  const label = path.basename(canonical)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48) || 'repo';
  const identity = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${label}-${identity}`;
}

export interface WorktreeRootLayout {
  configuredRoot: string;
  primaryBase: string;
  legacyBase: string;
  bases: string[];
  repoKey: string;
}

/**
 * Resolve the external worktree root for one repo while retaining the legacy
 * in-repo base as a read/cleanup compatibility location.
 */
export function resolveWorktreeRootLayout(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeRootLayout {
  const dataDir = getDataDir(env);
  const configuredRoot = path.resolve(env[WORKTREE_ROOT_ENV]?.trim() || path.join(dataDir, 'worktrees'));
  const repoKey = worktreeRepoKey(repoRoot);
  const primaryBase = path.join(configuredRoot, repoKey, LEGACY_WORKTREE_DIR_NAME);
  const legacyBase = path.join(path.resolve(repoRoot), LEGACY_WORKTREE_DIR_NAME);
  return {
    configuredRoot,
    primaryBase,
    legacyBase,
    bases: primaryBase === legacyBase ? [primaryBase] : [primaryBase, legacyBase],
    repoKey,
  };
}

/** Resolve the volume target used before a managed packet workspace exists. */
export function resolveManagedWorktreeStorageTarget(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const layout = resolveWorktreeRootLayout(repoRoot, env);
  if (!env[WORKTREE_ROOT_ENV]?.trim()) mkdirSync(layout.configuredRoot, { recursive: true });
  const configuredRoot = realpathSync.native(layout.configuredRoot);
  return path.resolve(configuredRoot, path.relative(layout.configuredRoot, layout.primaryBase));
}

export async function observeManagedWorktreeRootIdentity(
  repoRoot: string,
): Promise<StorageRootIdentity> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  if (!process.env[WORKTREE_ROOT_ENV]?.trim()) mkdirSync(layout.configuredRoot, { recursive: true });
  const link = await lstat(layout.configuredRoot);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new Error('Configured worktree root must be a real directory.');
  }
  const canonicalPath = await realpath(layout.configuredRoot);
  const identity = await stat(canonicalPath, { bigint: true });
  return {
    canonicalPath,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
  };
}

/** Re-prove root containment and device identity immediately before worktree materialization. */
export async function assertManagedWorktreeMaterializationBoundary(
  repoRoot: string,
  expectedVolumeId: string,
  expectedRoot: StorageRootIdentity,
): Promise<StorageRootIdentity> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  const rootLink = await lstat(layout.configuredRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
    throw new Error('Configured worktree root was replaced after storage admission.');
  }
  const canonicalRoot = await realpath(layout.configuredRoot);
  const rootIdentity = await stat(canonicalRoot, { bigint: true });
  if (canonicalRoot !== expectedRoot.canonicalPath
    || rootIdentity.dev.toString() !== expectedRoot.device
    || rootIdentity.ino.toString() !== expectedRoot.inode) {
    throw new Error('Configured worktree root identity changed after storage admission.');
  }
  const relativeBase = path.relative(layout.configuredRoot, layout.primaryBase);
  if (!relativeBase || relativeBase.startsWith('..') || path.isAbsolute(relativeBase)) {
    throw new Error('Managed worktree base is outside the configured worktree root.');
  }
  const pinnedBase = await ensurePinnedWorkspaceDirectory(layout.configuredRoot, {
    canonicalPath: canonicalRoot,
    device: Number(rootIdentity.dev),
    inode: Number(rootIdentity.ino),
  }, relativeBase.split(path.sep).join('/'));
  const observation = await observeStorageVolume(pinnedBase.canonicalPath);
  if (observation.status !== 'observed' || observation.volumeId !== expectedVolumeId) {
    throw new Error('Managed worktree volume changed after storage admission.');
  }
  if (pinnedBase.canonicalPath !== canonicalRoot
    && !pinnedBase.canonicalPath.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('Managed worktree base is not an exact directory under the admitted root.');
  }
  return {
    canonicalPath: pinnedBase.canonicalPath,
    device: pinnedBase.device.toString(),
    inode: pinnedBase.inode.toString(),
  };
}

/** Confirm the created workspace landed under the admitted root on the admitted device. */
export async function assertManagedWorktreeCreatedBoundary(
  repoRoot: string,
  createdPath: string,
  expectedVolumeId: string,
  expectedRoot: StorageRootIdentity,
  expectedBase: StorageRootIdentity,
): Promise<void> {
  const layout = resolveWorktreeRootLayout(repoRoot);
  const rootLink = await lstat(layout.configuredRoot);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) {
    throw new Error('Configured worktree root changed during materialization.');
  }
  const canonicalRoot = await realpath(layout.configuredRoot);
  const rootIdentity = await stat(canonicalRoot, { bigint: true });
  if (canonicalRoot !== expectedRoot.canonicalPath
    || rootIdentity.dev.toString() !== expectedRoot.device
    || rootIdentity.ino.toString() !== expectedRoot.inode) {
    throw new Error('Configured worktree root identity changed during materialization.');
  }
  const canonicalBase = await realpath(layout.primaryBase);
  const baseIdentity = await lstat(canonicalBase, { bigint: true });
  if (!baseIdentity.isDirectory() || baseIdentity.isSymbolicLink()
    || canonicalBase !== expectedBase.canonicalPath
    || baseIdentity.dev.toString() !== expectedBase.device
    || baseIdentity.ino.toString() !== expectedBase.inode) {
    throw new Error('Managed worktree base identity changed during materialization.');
  }
  const identity = await lstat(createdPath);
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('Created managed worktree is redirected or is not a directory.');
  }
  const canonicalCreated = await realpath(createdPath);
  if (!canonicalCreated.startsWith(`${canonicalBase}${path.sep}`)) {
    throw new Error('Created managed worktree resolves outside the admitted repository namespace.');
  }
  const observation = await observeStorageVolume(canonicalCreated);
  if (observation.status !== 'observed' || observation.volumeId !== expectedVolumeId) {
    throw new Error('Created managed worktree is not on the admitted volume.');
  }
}
