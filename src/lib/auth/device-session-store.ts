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
    };
  } catch {
    return null;
  }
}

export function writeDeviceSession(session: DeviceSession): void {
  const target = sessionPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    generation += 1;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function deleteDeviceSession(): void {
  generation += 1;
  rmSync(sessionPath(), { force: true });
}
