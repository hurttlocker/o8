import 'server-only';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

const SIGN_OUT_MARKER_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function markerPath(): string {
  return path.join(getDataDir(), 'auth-signed-out-at');
}

/**
 * Durable cross-process sign-out signal. The renderer writes it through the
 * entitlement sync route before clearing account state; ws-server reads it to
 * distinguish an explicit sign-out from a transient entitlement-cache miss.
 */
export function markAuthSignedOut(now: number = Date.now()): void {
  try {
    const filePath = markerPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${Math.floor(now / 1_000)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error('[entitlement] failed to mark sign-out:', error);
  }
}

export function clearAuthSignOutMarker(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch (error) {
    console.error('[entitlement] failed to clear sign-out marker:', error);
  }
}

export function readAuthSignedOutAt(now: number = Date.now()): number | null {
  try {
    const parsed = Number(readFileSync(markerPath(), 'utf8').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (Math.floor(now / 1_000) - parsed > SIGN_OUT_MARKER_MAX_AGE_SECONDS) {
      clearAuthSignOutMarker();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
