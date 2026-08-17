import { lstat } from 'node:fs/promises';
import path from 'node:path';

import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  removePreparedDependencySeedLease,
  type DependencySeedImageRecord,
  type DependencySeedLeaseRecord,
} from './dependency-seed-registry';
import { mountedDependencyImages } from './dependency-image-device-authority';
import { DependencyImageRefusalError } from './dependency-image-source-authority';

export interface DependencyImagePreparedLease {
  leaseId: string;
  recipeKey: string;
  generation: string;
  workspacePath: string;
}

export interface DependencyImageMount {
  leaseId: string;
  recipeKey: string;
  generation: string;
  imagePath: string;
  shadowPath: string;
  mountPath: string;
  deviceEntry: string;
  imageDevice: number;
  imageInode: number;
  shadowDevice: number;
  shadowInode: number;
}

export interface DependencyImageDetachOptions {
  afterShadowUnlinked?: (leaseId: string) => Promise<void>;
}

export type DependencyImageExpectedLease = DependencyImagePreparedLease;

export interface DependencyImageLeaseReconciliation extends DependencyImagePreparedLease {
  state: 'mounted' | 'detached' | 'blocked';
  note?: string;
}

export function asMount(
  lease: DependencySeedLeaseRecord,
  image: DependencySeedImageRecord,
): DependencyImageMount {
  if (!lease.deviceEntry || image.imageDevice === null || image.imageInode === null
    || lease.shadowDevice === null || lease.shadowInode === null) {
    throw new DependencyImageRefusalError('Dependency image lease has incomplete durable authority.');
  }
  return {
    leaseId: lease.leaseId,
    recipeKey: lease.recipeKey,
    generation: lease.generation,
    imagePath: image.imagePath,
    shadowPath: lease.shadowPath,
    mountPath: lease.mountPath,
    deviceEntry: lease.deviceEntry,
    imageDevice: image.imageDevice,
    imageInode: image.imageInode,
    shadowDevice: lease.shadowDevice,
    shadowInode: lease.shadowInode,
  };
}

export function dependencyImagePreparedLease(
  lease: DependencySeedLeaseRecord,
): DependencyImagePreparedLease {
  return {
    leaseId: lease.leaseId,
    recipeKey: lease.recipeKey,
    generation: lease.generation,
    workspacePath: lease.workspacePath,
  };
}

export function assertExpectedDependencyImageLease(
  lease: DependencySeedLeaseRecord | null,
  expected: DependencyImageExpectedLease | undefined,
): void {
  if (!expected) return;
  if (!lease
    || lease.leaseId !== expected.leaseId
    || lease.recipeKey !== expected.recipeKey
    || lease.generation !== expected.generation
    || lease.workspacePath !== path.resolve(expected.workspacePath)) {
    throw new DependencyImageRefusalError(
      'Persisted dependency mount differs from the expected lease receipt.',
    );
  }
}

export async function cancelAbandonedPreparedDependencyImageLease(
  lease: DependencySeedLeaseRecord,
): Promise<'cancelled' | 'owner-live' | 'recoverable'> {
  if (lease.state !== 'mounting' || lease.deviceEntry !== null
    || lease.helperPid !== null || lease.shadowDevice !== null
    || !isMetadataLockProcessIdentity(lease.ownerIdentity)) return 'recoverable';
  const owner = await probeMetadataLockProcessIdentity(lease.ownerPid);
  if (owner.state === 'unknown') {
    throw new DependencyImageRefusalError(
      'Prepared dependency mount owner authority is unknown.',
    );
  }
  if (owner.state === 'live'
    && sameMetadataLockProcessIdentity(owner.identity, lease.ownerIdentity)) return 'owner-live';
  const live = await mountedDependencyImages();
  if (live.some((entry) => entry.shadowPath === lease.shadowPath
    || entry.systemEntities.some((entity) => entity.mountPath === lease.mountPath))) return 'recoverable';
  try {
    await lstat(lease.shadowPath);
    return 'recoverable';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  removePreparedDependencySeedLease(lease.leaseId);
  return 'cancelled';
}
