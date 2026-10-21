import 'server-only';

import { readFileSync } from 'node:fs';
import { holdAccountRefresh, mutateAccountState } from './account-state';
import { removeAccountFile, writeAccountFile } from './account-state-files';
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
  mutateAccountState(() => {
    holdAccountRefresh();
    writeAccountFile(markerPath(), `${Math.floor(now / 1_000)}\n`);
  });
}

export function clearAuthSignOutMarker(): void {
  mutateAccountState(() => removeAccountFile(markerPath()));
}

export function readAuthSignedOutAt(now: number = Date.now()): number | null {
  try {
    const parsed = Number(readFileSync(markerPath(), 'utf8').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    if (Math.floor(now / 1_000) - parsed > SIGN_OUT_MARKER_MAX_AGE_SECONDS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
