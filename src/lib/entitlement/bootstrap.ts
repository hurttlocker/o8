import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

import { readCachedEntitlement, verifyLicense, writeCachedEntitlement } from './license';

/**
 * First-run free-account issuance (epic #1249, monetization plan §11).
 *
 * On a fresh install (no entitlement.json) this requests a FREE token from the
 * license server, bound to a stable per-install id, and caches it — so every
 * install has a stable account `sub` for usage attribution AND can reach the
 * managed proxy. There is no payment in this release; the token is a free
 * credential, not a receipt.
 *
 * Fail-soft by design: offline / server error → no-op, the app runs tokenless
 * and the next boot retries. NEVER overwrites an existing token (especially a
 * paid one) and NEVER blocks the UI.
 */

function dataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8');
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
    console.error('[entitlement-bootstrap] failed to persist install-id:', err);
  }
  return id;
}

let inFlight: Promise<void> | null = null;

export async function ensureFreeEntitlement(): Promise<void> {
  // Already holding a token (free or paid) → nothing to do.
  if (readCachedEntitlement()?.licenseKey) return;
  // An env-pinned plan (O8_PLAN) owns the entitlement → don't fetch one.
  if (process.env.O8_PLAN) return;

  // Single-flight: coalesce concurrent boot calls into one issuance.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const installId = getOrCreateInstallId();
      const res = await fetch(`${proxyBaseUrl()}/issue-free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { license?: unknown };
      const license = typeof data.license === 'string' ? data.license : '';
      if (!license) return;

      // Verify the server-minted token against the baked public key before we
      // trust + cache it (same path as a manually-applied license).
      const verified = await verifyLicense(license);
      if (!verified.valid || !verified.plan) return;

      writeCachedEntitlement({
        plan: verified.plan,
        status: 'active',
        expiresAt: verified.expiresAt,
        licenseKey: license,
      });
    } catch (err) {
      console.error('[entitlement-bootstrap] free issuance skipped:', err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
