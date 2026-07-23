import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const LEGACY_WORKTREE_DIR_NAME = '.cortex-worktrees';
export const WORKTREE_ROOT_ENV = 'O8_WORKTREE_ROOT';

function canonicalRepoRoot(repoRoot: string): string {
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
