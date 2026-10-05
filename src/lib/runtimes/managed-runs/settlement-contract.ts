import { createHash } from 'node:crypto';
import type { ManagedRunSettlementBinding } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9._:/-]{1,160}$/;

export function validProviderSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Declarative identity only. No paths, shell programs, or executable probes. */
export function parseSettlementBinding(value: unknown): ManagedRunSettlementBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 'o8/managed-run-settlement-binding/v1'
    || typeof v.executionKey !== 'string' || !IDENTITY.test(v.executionKey)
    || !Number.isSafeInteger(v.generation) || Number(v.generation) < 0
    || typeof v.branch !== 'string' || !v.branch.trim() || v.branch.length > 512
    || (v.providerSessionId !== null && !validProviderSessionId(v.providerSessionId))
    || typeof v.profileDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.profileDigest)
    || typeof v.receiptId !== 'string' || !IDENTITY.test(v.receiptId)) return null;
  return {
    schema: v.schema, executionKey: v.executionKey, generation: Number(v.generation),
    branch: v.branch, providerSessionId: v.providerSessionId as string | null,
    profileDigest: v.profileDigest, receiptId: v.receiptId,
  };
}

export function settlementBindingDigest(binding: ManagedRunSettlementBinding, cwd: string): string {
  return createHash('sha256').update(JSON.stringify([cwd, binding])).digest('hex');
}
