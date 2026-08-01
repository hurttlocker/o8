/**
 * Mobile E2EE — per-device token registry + enrollment.
 *
 * Each paired phone gets its own revocable token; we persist only the sha256
 * HASH (the token is returned once, at enrollment). `identity_public_key` is the
 * device's Ed25519 handshake key. The shared `~/.o8/ws-token` is validated
 * elsewhere and stays valid alongside these — per-device tokens are additive, so
 * the desktop webview and un-migrated phones never break.
 *
 * Enroll codes are short-lived single-use secrets carried by the pairing QR;
 * they bootstrap a device into the registry without a bearer token.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { writeActiveTokenHashes } from '@/lib/mobile/device-token-file';

export interface MobileDevice {
  id: string;
  deviceLabel: string | null;
  identityPublicKey: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceRow {
  id: string;
  token_hash: string;
  device_label: string | null;
  identity_public_key: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const TOKEN_BYTES = 32; // 256-bit per-device token
const ENROLL_CODE_BYTES = 16;
const ENROLL_CODE_TTL_MS = 5 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Rebuild the middleware's derived active-token-hash file from the DB. Called
 * after every enroll/revoke so the (DB-free) middleware sees the change.
 */
function syncTokenFile(): void {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(`SELECT token_hash FROM mobile_devices WHERE revoked_at IS NULL`)
    .all() as Array<{ token_hash: string }>;
  writeActiveTokenHashes(rows.map((r) => r.token_hash));
}

function toDevice(row: DeviceRow): MobileDevice {
  return {
    id: row.id,
    deviceLabel: row.device_label,
    identityPublicKey: row.identity_public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

// ── Enroll codes (in-memory, single-use, TTL) ──
// Process-local is fine: enrollment is a tight pair-time round-trip against the
// same ws-server/Next process, and a restart simply invalidates pending codes
// (the operator re-shows the QR). Never persisted.
const enrollCodes = new Map<string, number>(); // code → expiresAt(ms)

function sweepEnrollCodes(now: number): void {
  for (const [code, expiresAt] of enrollCodes) {
    if (expiresAt <= now) enrollCodes.delete(code);
  }
}

/** Mint a single-use enroll code for the pairing QR (5-min TTL). */
export function createEnrollCode(nowMs: number): string {
  sweepEnrollCodes(nowMs);
  const code = randomBytes(ENROLL_CODE_BYTES).toString('hex');
  enrollCodes.set(code, nowMs + ENROLL_CODE_TTL_MS);
  return code;
}

/** Validate + consume an enroll code (single-use). Returns true if it was valid. */
export function consumeEnrollCode(code: string, nowMs: number): boolean {
  sweepEnrollCodes(nowMs);
  const trimmed = code?.trim();
  if (!trimmed) return false;
  const expiresAt = enrollCodes.get(trimmed);
  if (expiresAt === undefined || expiresAt <= nowMs) {
    enrollCodes.delete(trimmed);
    return false;
  }
  enrollCodes.delete(trimmed); // single-use
  return true;
}

// ── Device registry ──

export interface EnrollResult {
  deviceId: string;
  /** The plaintext per-device token — returned ONCE; only its hash is stored. */
  deviceToken: string;
}

/** Register a device's identity + mint its token. Caller must validate the enroll code first. */
export function enrollDevice(input: { identityPublicKey: string; deviceLabel?: string | null }): EnrollResult {
  const sqlite = getSqlite();
  const deviceId = randomUUID();
  const deviceToken = randomBytes(TOKEN_BYTES).toString('hex');
  sqlite
    .prepare(
      `INSERT INTO mobile_devices (id, token_hash, device_label, identity_public_key)
       VALUES (?, ?, ?, ?)`,
    )
    .run(deviceId, hashToken(deviceToken), input.deviceLabel?.trim() || null, input.identityPublicKey);
  syncTokenFile();
  return { deviceId, deviceToken };
}

/**
 * Resolve a presented token to an ACTIVE (non-revoked) device, stamping
 * last_seen. Returns null for unknown/revoked tokens. This is the per-device
 * half of token validation; the shared-token check lives at the call sites.
 */
export function resolveDeviceByToken(token: string): MobileDevice | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(`SELECT * FROM mobile_devices WHERE token_hash = ? AND revoked_at IS NULL`)
    .get(hashToken(trimmed)) as DeviceRow | undefined;
  if (!row) return null;
  // Stamp last_seen and reflect it in the returned object (callers treat a
  // successful resolve as "this device was just seen").
  const seenAt = sqlite
    .prepare(`UPDATE mobile_devices SET last_seen_at = datetime('now') WHERE id = ? RETURNING last_seen_at`)
    .get(row.id) as { last_seen_at: string } | undefined;
  return toDevice({ ...row, last_seen_at: seenAt?.last_seen_at ?? row.last_seen_at });
}

/**
 * Does this token belong to a KNOWN-but-REVOKED device? Lets the WS gate tell a
 * revoked reconnect apart from a totally-unknown token, so it can return a clean
 * 4401 close (deterministic "you were revoked" signal) instead of a generic
 * upgrade rejection the phone can't distinguish from a network blip.
 */
export function isTokenRevoked(token: string): boolean {
  const trimmed = token?.trim();
  if (!trimmed) return false;
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(`SELECT 1 FROM mobile_devices WHERE token_hash = ? AND revoked_at IS NOT NULL`)
    .get(hashToken(trimmed)) as { 1: number } | undefined;
  return Boolean(row);
}

/** Is this device still active (exists + not revoked)? Used by the WS revoke sweep. */
export function isDeviceActive(deviceId: string): boolean {
  if (!deviceId) return false;
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(`SELECT 1 FROM mobile_devices WHERE id = ? AND revoked_at IS NULL`)
    .get(deviceId) as { 1: number } | undefined;
  return Boolean(row);
}

/** List devices (newest first) for the operator's "Paired devices" surface. */
export function listDevices(): MobileDevice[] {
  const sqlite = getSqlite();
  const rows = sqlite
    .prepare(`SELECT * FROM mobile_devices ORDER BY created_at DESC`)
    .all() as DeviceRow[];
  return rows.map(toDevice);
}

/** Revoke a device. Returns true if a row transitioned to revoked. */
export function revokeDevice(deviceId: string): boolean {
  const sqlite = getSqlite();
  const result = sqlite
    .prepare(`UPDATE mobile_devices SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`)
    .run(deviceId);
  if (result.changes > 0) syncTokenFile();
  return result.changes > 0;
}
