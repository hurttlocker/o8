import { lstat, realpath } from 'node:fs/promises';

import type { WorktreeMetaEntry } from './types';
import { resolveStorageVolumeId } from './storage-telemetry';

export type WorktreeMaterializationIdentity = NonNullable<WorktreeMetaEntry['materializationIdentity']>;

export interface MaterializationIdentityAssertionOptions {
  legacyVolumeId?: string;
}

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
  const volumeId = await resolveStorageVolumeId(canonicalPath);
  const repeated = await lstat(workspacePath);
  if (!repeated.isDirectory() || repeated.isSymbolicLink()
    || repeated.dev !== before.dev || repeated.ino !== before.ino
    || await realpath(workspacePath) !== canonicalPath) {
    throw new Error('Managed workspace materialization changed during volume identity capture.');
  }
  return {
    device: before.dev,
    inode: before.ino,
    canonicalPath,
    volumeId,
  };
}

/** Re-prove the exact directory receipt immediately before a workspace consumer acts. */
export async function assertWorktreeMaterializationIdentity(
  workspacePath: string,
  expected: WorktreeMaterializationIdentity | undefined,
  options: MaterializationIdentityAssertionOptions = {},
): Promise<WorktreeMaterializationIdentity> {
  if (!expected) {
    throw new Error('Managed workspace materialization has no durable ownership receipt.');
  }
  const actual = await captureWorktreeMaterializationIdentity(workspacePath);
  if (actual.canonicalPath !== expected.canonicalPath) {
    throw new Error('Managed workspace materialization ownership changed: canonical path mismatch.');
  }
  if (actual.inode !== expected.inode) {
    throw new Error('Managed workspace materialization ownership changed: inode mismatch.');
  }
  if (expected.volumeId && actual.volumeId !== expected.volumeId) {
    throw new Error('Managed workspace materialization ownership changed: volume identity mismatch.');
  }
  if (!expected.volumeId && actual.device !== expected.device
    && actual.volumeId !== options.legacyVolumeId) {
    throw new Error('Managed workspace materialization ownership changed: device mismatch without a matching stable volume identity.');
  }
  return actual;
}
