import { lstat, realpath } from 'node:fs/promises';

import type { WorktreeMetaEntry } from './types';

export type WorktreeMaterializationIdentity = NonNullable<WorktreeMetaEntry['materializationIdentity']>;

/** Capture one regular directory through both its lexical and canonical names. */
export async function captureWorktreeMaterializationIdentity(
  workspacePath: string,
): Promise<WorktreeMaterializationIdentity> {
  const before = await lstat(workspacePath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('Managed workspace materialization is not a regular directory.');
  }
  const canonicalPath = await realpath(workspacePath);
  const [after, canonical] = await Promise.all([
    lstat(workspacePath),
    lstat(canonicalPath),
  ]);
  if (!after.isDirectory() || after.isSymbolicLink()
    || !canonical.isDirectory() || canonical.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.dev !== canonical.dev || before.ino !== canonical.ino) {
    throw new Error('Managed workspace materialization changed during ownership capture.');
  }
  return { device: before.dev, inode: before.ino, canonicalPath };
}

/** Re-prove the exact directory receipt immediately before a workspace consumer acts. */
export async function assertWorktreeMaterializationIdentity(
  workspacePath: string,
  expected: WorktreeMaterializationIdentity | undefined,
): Promise<WorktreeMaterializationIdentity> {
  if (!expected) {
    throw new Error('Managed workspace materialization has no durable ownership receipt.');
  }
  const actual = await captureWorktreeMaterializationIdentity(workspacePath);
  if (actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.canonicalPath !== expected.canonicalPath) {
    throw new Error('Managed workspace materialization ownership changed.');
  }
  return actual;
}
