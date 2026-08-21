import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  ResourceLeaseSafetyError,
  normalizeResourceLeaseActor,
  normalizeResourceLeaseClaimToken,
  normalizeResourceLeaseOwner,
  type ObservedResourceLeaseOwner,
  type ResourceLeaseOwnerInput,
  type ResourceLeaseParticipant,
} from './resource-lease-types';

interface StoredLeaseOwner {
  owner_id: string;
  owner_pid: number;
  owner_identity_json: string;
  claim_token_hash: string | null;
}

export function parseResourceLeaseProcessIdentity(value: string): MetadataLockProcessIdentity | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isMetadataLockProcessIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resourceLeaseClaimTokenHash(token: string): string {
  return createHash('sha256')
    .update(normalizeResourceLeaseClaimToken(token), 'utf8')
    .digest('hex');
}

export function sameResourceLeaseClaimHash(stored: string | null, presented: string): boolean {
  if (!stored || !/^[a-f0-9]{64}$/.test(stored) || !/^[a-f0-9]{64}$/.test(presented)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(presented, 'hex'));
}

export function sameObservedResourceLeaseOwner(
  row: StoredLeaseOwner,
  owner: ObservedResourceLeaseOwner,
): boolean {
  const storedIdentity = parseResourceLeaseProcessIdentity(row.owner_identity_json);
  return row.owner_id === owner.id
    && row.owner_pid === owner.pid
    && storedIdentity !== null
    && sameMetadataLockProcessIdentity(storedIdentity, owner.identity);
}

export function sameObservedResourceLeaseParticipant(
  row: StoredLeaseOwner,
  participant: ResourceLeaseParticipant,
): boolean {
  return sameObservedResourceLeaseOwner(row, participant.owner)
    && sameResourceLeaseClaimHash(row.claim_token_hash, participant.claimTokenHash);
}

export async function observeResourceLeaseParticipant(input: {
  owner: ResourceLeaseOwnerInput;
  waiterPid?: number;
  actor: string;
  claimToken: string;
}): Promise<ResourceLeaseParticipant> {
  const owner = normalizeResourceLeaseOwner(input.owner);
  const actor = normalizeResourceLeaseActor(input.actor);
  const normalizedClaimToken = normalizeResourceLeaseClaimToken(input.claimToken);
  const waiterPid = input.waiterPid ?? owner.pid;
  if (!Number.isSafeInteger(waiterPid) || waiterPid <= 0) {
    throw new ResourceLeaseSafetyError('waiter_identity_unknown', 'Lease waiter PID is invalid.');
  }
  const ownerProbe = await probeMetadataLockProcessIdentity(owner.pid);
  if (ownerProbe.state !== 'live') {
    throw new ResourceLeaseSafetyError(
      'owner_identity_unknown',
      ownerProbe.state === 'unknown'
        ? `Lease owner identity is unknown: ${ownerProbe.detail}`
        : 'Lease owner process is no longer live.',
    );
  }
  const waiterProbe = waiterPid === owner.pid
    ? ownerProbe
    : await probeMetadataLockProcessIdentity(waiterPid);
  if (waiterProbe.state !== 'live') {
    throw new ResourceLeaseSafetyError(
      'waiter_identity_unknown',
      waiterProbe.state === 'unknown'
        ? `Lease waiter identity is unknown: ${waiterProbe.detail}`
        : 'Lease waiter process is no longer live.',
    );
  }
  return {
    owner: { ...owner, identity: ownerProbe.identity },
    waiterPid,
    waiterIdentity: waiterProbe.identity,
    actor,
    claimTokenHash: resourceLeaseClaimTokenHash(normalizedClaimToken),
  };
}
