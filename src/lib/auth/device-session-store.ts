import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface DeviceSession {
  token: string;
  clerkUserId: string;
  installId: string;
  idleExpiresAt: string;
  /** Persisted before sending, so a restart cannot replay an uncertain rotation late. */
  renewalStartedAt?: number;
}

let generation = 0;

function sessionPath(): string {
  return join(getDataDir(), 'device-session.json');
}

/** Invalidates in-flight enrollments even when revoke finds no existing file. */
export function deviceSessionGeneration(): number {
  return generation;
}

export function readDeviceSession(): DeviceSession | null {
  try {
    const record: unknown = JSON.parse(readFileSync(sessionPath(), 'utf8'));
    if (!record || typeof record !== 'object') return null;
    const value = record as Record<string, unknown>;
    if (['token', 'clerkUserId', 'installId', 'idleExpiresAt'].some((key) => (
      typeof value[key] !== 'string' || !value[key].trim()
    )) || !Number.isFinite(Date.parse(value.idleExpiresAt as string))) return null;
    return {
      token: value.token as string, clerkUserId: value.clerkUserId as string,
      installId: value.installId as string, idleExpiresAt: value.idleExpiresAt as string,
      ...(typeof value.renewalStartedAt === 'number' && Number.isFinite(value.renewalStartedAt)
        ? { renewalStartedAt: value.renewalStartedAt } : {}),
    };
  } catch {
    return null;
  }
}

function writePrivateRecord(target: string, record: unknown): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeDeviceSession(session: DeviceSession): void {
  writePrivateRecord(sessionPath(), session);
  generation += 1;
}

function pendingRevokePath(): string {
  return join(getDataDir(), 'device-revoke-pending.json');
}

export function readPendingDeviceRevokes(): string[] {
  try {
    const record: unknown = JSON.parse(readFileSync(pendingRevokePath(), 'utf8'));
    if (!Array.isArray(record) || record.some((token) => typeof token !== 'string' || !token.trim())) {
      throw new Error('Invalid pending device revocation.');
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function queueDeviceRevoke(token: string): void {
  writePrivateRecord(pendingRevokePath(), [...new Set([...readPendingDeviceRevokes(), token])]);
}

export function removePendingDeviceRevoke(token: string): void {
  const remaining = readPendingDeviceRevokes().filter((pending) => pending !== token);
  if (remaining.length) writePrivateRecord(pendingRevokePath(), remaining);
  else rmSync(pendingRevokePath(), { force: true });
}

export function deleteDeviceSession(): void {
  generation += 1;
  rmSync(sessionPath(), { force: true });
}
