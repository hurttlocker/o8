import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mutateAccountState, withSynchronousAccountStateLease } from './account-state';
import { removeAccountFile, writeAccountFile } from './account-state-files';
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
      ...(Object.hasOwn(value, 'renewalStartedAt') ? {
        renewalStartedAt: typeof value.renewalStartedAt === 'number' && Number.isFinite(value.renewalStartedAt)
          ? value.renewalStartedAt : 0,
      } : {}),
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
  mutateAccountState(() => {
    writeAccountFile(sessionPath(), `${JSON.stringify(session)}\n`);
    generation += 1;
  });
}

function pendingRevokePath(): string {
  return join(getDataDir(), 'device-revoke-pending.json');
}

export function readPendingDeviceRevokes(): string[] {
  let raw: string;
  try {
    raw = readFileSync(pendingRevokePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const record = JSON.parse(raw) as { version?: unknown; tokens?: unknown } | null;
    // Legacy arrays may contain superseded tokens queued by an older client.
    if (!record || record.version !== 1 || !Array.isArray(record.tokens)
      || record.tokens.some((token) => typeof token !== 'string' || !token.trim())) throw new Error('Invalid pending state');
    const session = readDeviceSession();
    return [...new Set<string>(record.tokens)].slice(-16)
      .filter((token) => session?.renewalStartedAt === undefined || session.token !== token);
  } catch {
    // Never forward or print contents whose current-token provenance is unknown.
    try { rmSync(pendingRevokePath(), { force: true }); } catch { /* fail closed */ }
    console.warn('[auth] discarded invalid pending device revocation state');
    return [];
  }
}

/**
 * The stored session, unless its token is already queued for revocation. That
 * only happens when a sign-out was interrupted between queueing and deleting.
 * Rotating such a token would turn the queued revoke into a replay after grace,
 * which the server treats as reuse, so the token is retired instead.
 */
export function readUsableDeviceSession(): DeviceSession | null {
  return withSynchronousAccountStateLease(() => {
    const session = readDeviceSession();
    if (!session || !readPendingDeviceRevokes().includes(session.token)) return session;
    deleteDeviceSession();
    return null;
  });
}

export function queueDeviceRevoke(token: string): void {
  writePrivateRecord(pendingRevokePath(), { version: 1, tokens: [...new Set([...readPendingDeviceRevokes(), token])].slice(-16) });
}

export function removePendingDeviceRevoke(token: string): void {
  const remaining = readPendingDeviceRevokes().filter((pending) => pending !== token);
  if (remaining.length) writePrivateRecord(pendingRevokePath(), { version: 1, tokens: remaining });
  else rmSync(pendingRevokePath(), { force: true });
}

export function deleteDeviceSession(): void {
  mutateAccountState(() => {
    removeAccountFile(sessionPath());
    generation += 1;
  });
}

function handoffPath(): string {
  return join(getDataDir(), 'desktop-auth-handoff.json');
}

export function beginDesktopAuthHandoff(): string {
  const state = randomUUID();
  writePrivateRecord(handoffPath(), { state });
  return state;
}

export function invalidateDesktopAuthHandoff(): void {
  rmSync(handoffPath(), { force: true });
}

export function consumeDesktopAuthHandoff(state: string): boolean {
  try {
    const record = JSON.parse(readFileSync(handoffPath(), 'utf8')) as { state?: unknown } | null;
    if (!state || record?.state !== state) return false;
    invalidateDesktopAuthHandoff();
    return true;
  } catch {
    return false;
  }
}
