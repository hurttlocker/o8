import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export const DEFAULT_RESOURCE_LEASE_TTL_MS = 2 * 60 * 60_000;
export const MIN_RESOURCE_LEASE_TTL_MS = 1_000;
export const MAX_RESOURCE_LEASE_TTL_MS = 24 * 60 * 60_000;
export const MAX_RESOURCE_NAME_LENGTH = 2_048;
export const MAX_RESOURCE_LEASE_WAITER_ID_LENGTH = 512;

export interface ResourceLeaseOwnerInput {
  id: string;
  label: string;
  pid: number;
}

export interface ObservedResourceLeaseOwner extends ResourceLeaseOwnerInput {
  identity: MetadataLockProcessIdentity;
}

export interface ResourceLeaseParticipant {
  owner: ObservedResourceLeaseOwner;
  waiterPid: number;
  waiterIdentity: MetadataLockProcessIdentity;
}

export interface ResourceLeaseHolder {
  resource: string;
  leaseId: string;
  owner: ResourceLeaseOwnerInput;
  acquiredAt: string;
  ttlMs: number;
  heartbeatAt: string;
  expiresAt: string;
  overdue: boolean;
}

export interface ResourceLeaseWaiter {
  waiterId: string;
  resource: string;
  owner: ResourceLeaseOwnerInput;
  position: number;
  enqueuedAt: string;
  lastSeenAt: string;
  ttlMs: number;
}

export interface ResourceLeaseSnapshot {
  schema: 'o8/resource-lease/v1';
  resource: string;
  holder: ResourceLeaseHolder | null;
  waiters: ResourceLeaseWaiter[];
  blocked: {
    code: 'holder_identity_unknown' | 'waiter_identity_unknown';
    message: string;
  } | null;
}

export type ResourceLeaseAcquireResult =
  | {
      state: 'acquired';
      lease: ResourceLeaseHolder;
      waited: boolean;
      replayed: boolean;
    }
  | {
      state: 'queued';
      waiter: ResourceLeaseWaiter;
      holder: ResourceLeaseHolder | null;
      blocked: ResourceLeaseSnapshot['blocked'];
    }
  | {
      state: 'refused';
      reason: 'held' | 'fifo_waiter_precedes' | 'identity_unknown';
      holder: ResourceLeaseHolder | null;
      nextWaiter: ResourceLeaseWaiter | null;
      blocked: ResourceLeaseSnapshot['blocked'];
    };

export interface ResourceLeaseReleaseResult {
  released: boolean;
  lease: ResourceLeaseHolder | null;
  nextHolder: ResourceLeaseHolder | null;
  refusal: {
    code: 'not_found' | 'not_owner' | 'identity_unknown';
    message: string;
    holder: ResourceLeaseHolder | null;
  } | null;
}

export class ResourceLeaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLeaseInputError';
  }
}

export class ResourceLeaseSafetyError extends Error {
  constructor(
    public code: 'owner_identity_unknown' | 'waiter_identity_unknown' | 'persistence_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ResourceLeaseSafetyError';
  }
}

export function normalizeResourceName(value: string): string {
  const resource = value.trim();
  if (!resource) throw new ResourceLeaseInputError('Resource name is required.');
  if (resource.length > MAX_RESOURCE_NAME_LENGTH) {
    throw new ResourceLeaseInputError(`Resource name must not exceed ${MAX_RESOURCE_NAME_LENGTH} characters.`);
  }
  if (/[^\x20-\x7e]/.test(resource)) {
    throw new ResourceLeaseInputError('Resource name must contain printable ASCII characters only.');
  }
  return resource;
}

export function normalizeResourceLeaseTtl(value: number | undefined): number {
  const ttlMs = value ?? DEFAULT_RESOURCE_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs)
    || ttlMs < MIN_RESOURCE_LEASE_TTL_MS
    || ttlMs > MAX_RESOURCE_LEASE_TTL_MS) {
    throw new ResourceLeaseInputError(
      `Lease TTL must be an integer from ${MIN_RESOURCE_LEASE_TTL_MS} to ${MAX_RESOURCE_LEASE_TTL_MS} milliseconds.`,
    );
  }
  return ttlMs;
}

export function normalizeResourceLeaseOwner(input: ResourceLeaseOwnerInput): ResourceLeaseOwnerInput {
  const id = input.id.trim();
  const label = input.label.trim().replace(/\s+/g, ' ');
  if (!id || id.length > 256 || /[^\x20-\x7e]/.test(id)) {
    throw new ResourceLeaseInputError('Lease owner id must be 1 to 256 printable ASCII characters.');
  }
  if (!label || label.length > 128 || /[^\x20-\x7e]/.test(label)) {
    throw new ResourceLeaseInputError('Lease owner label must be 1 to 128 printable ASCII characters.');
  }
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new ResourceLeaseInputError('Lease owner PID must be a positive safe integer.');
  }
  return { id, label, pid: input.pid };
}

export function normalizeResourceLeaseWaiterId(value: string | undefined): string | null {
  const waiterId = value?.trim() ?? '';
  if (!waiterId) return null;
  if (waiterId.length > MAX_RESOURCE_LEASE_WAITER_ID_LENGTH || /[^\x20-\x7e]/.test(waiterId)) {
    throw new ResourceLeaseInputError(
      `Lease waiter id must not exceed ${MAX_RESOURCE_LEASE_WAITER_ID_LENGTH} printable ASCII characters.`,
    );
  }
  return waiterId;
}
