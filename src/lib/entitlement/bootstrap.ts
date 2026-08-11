import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  configuredLicenseServerBaseUrl,
  readCachedEntitlement,
  verifyLicense,
  writeCachedEntitlement,
} from './license';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * On-demand hosted allowance issuance (epic #1249, monetization plan
 * §11).
 *
 * When the user invokes the o8 managed model, a keyless install requests a FREE
 * token bound to a stable per-install id. Normal startup, local inference, and
 * BYOK stay offline. Pure-BYO installs can also opt out with O8_PROXY_URL=off.
 *
 * Fail-soft by design: offline / server error → bounded no-op with a cooldown.
 * NEVER overwrites an existing token (especially a paid one) and NEVER blocks
 * the UI indefinitely.
 */

const LICENSE_SERVER_TIMEOUT_MS = 5_000;
const LICENSE_SERVER_RETRY_COOLDOWN_MS = 5 * 60_000;

function dataDir(): string {
  return getDataDir();
}

/** Stable per-install id (the analytics account identity). Created once, then
 *  persisted to ~/.o8/install-id so re-issues map to the same account. */
export function getOrCreateInstallId(): string {
  const idPath = path.join(dataDir(), 'install-id');
  try {
    const existing = readFileSync(idPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // missing — create below
  }
  const id = randomUUID();
  try {
    mkdirSync(path.dirname(idPath), { recursive: true });
    writeFileSync(idPath, `${id}\n`, { mode: 0o600 });
  } catch (err) {
    console.error('[entitlement] Failed to persist install id:', err);
  }
  return id;
}

let inFlight: Promise<void> | null = null;
let retryAfterMs = 0;

export async function ensureFreeEntitlement(): Promise<void> {
  // Already holding a token (free or paid) → nothing to do.
  if (readCachedEntitlement()?.licenseKey) return;
  // An env-pinned plan (O8_PLAN) owns the entitlement → don't fetch one.
  if (process.env.O8_PLAN) return;
  const licenseServerBaseUrl = configuredLicenseServerBaseUrl();
  if (!licenseServerBaseUrl) {
    console.debug('[entitlement] License server not configured; using free plan.');
    return;
  }
  if (Date.now() < retryAfterMs) return;

  // Single-flight: coalesce concurrent boot calls into one issuance.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const installId = getOrCreateInstallId();
      const res = await fetch(`${licenseServerBaseUrl}/issue-free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId }),
        signal: AbortSignal.timeout(LICENSE_SERVER_TIMEOUT_MS),
      });
      if (!res.ok) {
        retryAfterMs = Date.now() + LICENSE_SERVER_RETRY_COOLDOWN_MS;
        console.debug(`[entitlement] License server returned ${res.status}; using free plan.`);
        return;
      }
      const data = (await res.json()) as { license?: unknown };
      const license = typeof data.license === 'string' ? data.license : '';
      if (!license) {
        retryAfterMs = Date.now() + LICENSE_SERVER_RETRY_COOLDOWN_MS;
        console.debug('[entitlement] License server returned no license; using free plan.');
        return;
      }

      // Verify the server-minted token against the baked public key before we
      // trust + cache it (same path as a manually-applied license).
      const verified = await verifyLicense(license);
      if (!verified.valid || !verified.plan) {
        retryAfterMs = Date.now() + LICENSE_SERVER_RETRY_COOLDOWN_MS;
        console.debug('[entitlement] License server returned an invalid license; using free plan.');
        return;
      }

      writeCachedEntitlement({
        plan: verified.plan,
        status: 'active',
        expiresAt: verified.expiresAt,
        licenseKey: license,
      });
    } catch {
      retryAfterMs = Date.now() + LICENSE_SERVER_RETRY_COOLDOWN_MS;
      console.debug('[entitlement] License server unavailable; using free plan.');
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
