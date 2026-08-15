import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  ExactWorktreeQuarantineInspection,
  ExactWorktreeQuarantineLocation,
} from './worktree-exact';
import { renameExactChildDirectory } from './exact-parent-operation';
import { transitionExactWorkspaceClaim } from './exact-workspace-claim-state';

export class ExactWorktreeQuarantineError extends Error {
  readonly code = 'exact_quarantine_incomplete';

  constructor(
    message: string,
    readonly phase: 'verify' | 'restore' | 'remove' | 'receipt-cleanup',
    readonly location: ExactWorktreeQuarantineLocation,
  ) {
    super(message);
    this.name = 'ExactWorktreeQuarantineError';
  }
}

export function heldQuarantinePath(inspection: ExactWorktreeQuarantineInspection): string {
  return inspection.purgingPath ?? inspection.claimedPath ?? inspection.location.quarantinePath;
}

export async function claimExactWorktreeQuarantine(
  inspection: ExactWorktreeQuarantineInspection,
  beforeClaim?: () => Promise<void>,
): Promise<string> {
  if (inspection.state !== 'quarantined' || !inspection.receipt) {
    throw new Error(`Exact quarantine claim refused: ${inspection.note}`);
  }
  const { location, receipt } = inspection;
  const sourcePath = heldQuarantinePath(inspection);
  const claimPath = path.join(location.quarantineRoot, `${location.claimPrefix}${randomUUID()}`);
  const rootStat = await lstat(location.quarantineRoot);
  if (!rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || rootStat.dev !== receipt.quarantineRootDevice
    || rootStat.ino !== receipt.quarantineRootInode
    || await realpath(location.quarantineRoot) !== receipt.canonicalQuarantineRoot) {
    throw new Error('Exact quarantine claim refused because its root identity changed.');
  }
  await beforeClaim?.();
  await renameExactChildDirectory(
    location.quarantineRoot,
    {
      device: receipt.quarantineRootDevice,
      inode: receipt.quarantineRootInode,
      canonicalPath: receipt.canonicalQuarantineRoot,
    },
    sourcePath,
    claimPath,
    { device: receipt.sourceDevice, inode: receipt.sourceInode },
  );
  const claimStat = await lstat(claimPath).catch(() => null);
  if (!claimStat?.isDirectory()
    || claimStat.isSymbolicLink()
    || claimStat.dev !== receipt.sourceDevice
    || claimStat.ino !== receipt.sourceInode) {
    throw new ExactWorktreeQuarantineError(
      'Exact quarantine claim captured an unexpected directory; it was preserved for manual recovery.',
      'verify',
      location,
    );
  }
  return claimPath;
}

export async function markClaimedQuarantinePurging(
  inspection: ExactWorktreeQuarantineInspection,
  claimPath: string,
  beforeRename?: () => Promise<void>,
): Promise<string> {
  const receipt = inspection.receipt;
  if (!receipt || inspection.state !== 'quarantined') {
    throw new Error('Exact quarantine content-release boundary requires a trusted quarantine receipt.');
  }
  const claimed = await lstat(claimPath);
  if (!claimed.isDirectory()
    || claimed.isSymbolicLink()
    || claimed.dev !== receipt.sourceDevice
    || claimed.ino !== receipt.sourceInode) {
    throw new Error('Exact quarantine content-release boundary refused a changed claim identity.');
  }
  const purgePath = path.join(
    inspection.location.quarantineRoot,
    `${inspection.location.purgePrefix}${randomUUID()}`,
  );
  await beforeRename?.();
  await renameExactChildDirectory(
    inspection.location.quarantineRoot,
    {
      device: receipt.quarantineRootDevice,
      inode: receipt.quarantineRootInode,
      canonicalPath: receipt.canonicalQuarantineRoot,
    },
    claimPath,
    purgePath,
    { device: receipt.sourceDevice, inode: receipt.sourceInode },
  );
  const moved = await lstat(purgePath).catch(() => null);
  if (!moved?.isDirectory()
    || moved.isSymbolicLink()
    || moved.dev !== receipt.sourceDevice
    || moved.ino !== receipt.sourceInode) {
    throw new ExactWorktreeQuarantineError(
      'Exact quarantine content-release boundary captured an unexpected directory.',
      'verify',
      inspection.location,
    );
  }
  transitionExactWorkspaceClaim({
    kind: 'worktree-quarantine',
    repositoryPath: receipt.repoPath,
    worktreeId: receipt.worktreeId,
    operationId: inspection.location.identity,
    expectedState: 'claimed',
    toState: 'purging',
    claimIdentity: { device: receipt.sourceDevice, inode: receipt.sourceInode },
  });
  return purgePath;
}

export async function restoreClaimedQuarantine(
  inspection: ExactWorktreeQuarantineInspection,
  claimPath: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const receipt = inspection.receipt;
  const original = await lstat(inspection.location.originalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!receipt || original) {
    throw new Error('Exact quarantine restore refused because the original path is occupied.');
  }
  const claimStat = await lstat(claimPath);
  if (!claimStat.isDirectory()
    || claimStat.isSymbolicLink()
    || claimStat.dev !== receipt.sourceDevice
    || claimStat.ino !== receipt.sourceInode) {
    throw new Error('Exact quarantine restore refused because the claimed directory identity changed.');
  }
  await beforeRename?.();
  await renameExactChildDirectory(
    inspection.location.quarantineRoot,
    {
      device: receipt.quarantineRootDevice,
      inode: receipt.quarantineRootInode,
      canonicalPath: receipt.canonicalQuarantineRoot,
    },
    claimPath,
    inspection.location.originalPath,
    { device: receipt.sourceDevice, inode: receipt.sourceInode },
  );
  const restored = await lstat(inspection.location.originalPath);
  if (!restored.isDirectory()
    || restored.isSymbolicLink()
    || restored.dev !== receipt.sourceDevice
    || restored.ino !== receipt.sourceInode) {
    throw new Error('Exact quarantine restore did not materialize the receipted directory identity.');
  }
}
