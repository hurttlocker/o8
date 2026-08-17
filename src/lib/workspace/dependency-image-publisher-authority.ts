import {
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import type { DependencySeedImageRecord } from './dependency-seed-registry';
import {
  DependencyImageRefusalError,
  type DependencyImageSourceReceipt,
} from './dependency-image-source-authority';

export interface DependencyImagePublisherAuthority {
  pid: number;
  identity: MetadataLockProcessIdentity;
}

export async function currentDependencyImageOwner(): Promise<DependencyImagePublisherAuthority> {
  const probe = await probeMetadataLockProcessIdentity(process.pid);
  if (probe.state !== 'live') {
    throw new DependencyImageRefusalError(
      'Current dependency image owner cannot be identified.',
    );
  }
  return { pid: process.pid, identity: probe.identity };
}

export function sameDependencyImagePublisher(
  record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
): boolean {
  return record.publisherPid === publisher.pid
    && record.publisherIdentity !== null
    && sameMetadataLockProcessIdentity(record.publisherIdentity, publisher.identity);
}

export function assertDependencyImagePublicationSource(
  record: DependencySeedImageRecord,
  receipt: DependencyImageSourceReceipt,
): void {
  if (record.sourceTreeDigest !== receipt.treeDigest) {
    throw new DependencyImageRefusalError(
      'Concurrent dependency image publication has a different install-time source receipt.',
    );
  }
}
