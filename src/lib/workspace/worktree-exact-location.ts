import { createHash } from 'node:crypto';
import path from 'node:path';

import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import type {
  ExactWorktreeQuarantineLocation,
  ExactWorktreeQuarantineLocatorInput,
} from './worktree-exact';

export function exactManagedPath(
  repoPath: string,
  worktreeId: string,
  expectedPath: string,
): string {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedTarget = path.resolve(expectedPath);
  if (!worktreeId.trim() || path.basename(resolvedTarget) !== worktreeId) {
    throw new Error('Exact worktree operation refused an invalid worktree identity.');
  }
  if (resolvedTarget === resolvedRepo) {
    throw new Error('Exact worktree operation refused the registered repo root.');
  }
  const containingBase = resolveWorktreeRootLayout(resolvedRepo).bases
    .map((base) => path.resolve(base))
    .find((base) => resolvedTarget.startsWith(`${base}${path.sep}`));
  if (!containingBase || path.dirname(resolvedTarget) !== containingBase) {
    throw new Error('Exact worktree path is outside the managed worktree roots.');
  }
  return resolvedTarget;
}

export function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function exactQuarantineLocation(
  input: ExactWorktreeQuarantineLocatorInput,
): ExactWorktreeQuarantineLocation {
  const repoPath = path.resolve(input.repoPath);
  const originalPath = exactManagedPath(repoPath, input.worktreeId, input.expectedPath);
  const snapshotFingerprint = requiredText(input.quarantine.snapshotFingerprint, 'snapshotFingerprint');
  if (input.quarantine.intent !== 'park' && input.quarantine.intent !== 'restore-rollback') {
    throw new Error('Exact quarantine intent is invalid.');
  }
  const identity = createHash('sha256')
    .update([
      'o8-exact-worktree-quarantine-v1',
      repoPath,
      input.worktreeId,
      originalPath,
      snapshotFingerprint,
      input.quarantine.intent,
    ].join('\0'))
    .digest('hex');
  const quarantineRoot = path.dirname(originalPath);
  const basename = `.o8-park-workspace-${identity}`;
  return {
    identity,
    originalPath,
    quarantineRoot,
    quarantinePath: path.join(quarantineRoot, basename),
    receiptPath: path.join(quarantineRoot, `${basename}.json`),
    claimPrefix: `${basename}.claim-`,
    purgePrefix: `${basename}.purge-`,
  };
}
