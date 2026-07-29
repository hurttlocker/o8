import 'dotenv/config';

/**
 * Boot-time environment validation for the o8 relay.
 *
 * Mirrors services/license-server/src/env.ts: required vars are read + validated
 * at import time so the process fails fast on Railway rather than mid-connection.
 * Optional vars get sane defaults.
 *
 * The relay holds only the license server's PUBLIC key (to verify plan and
 * machine JWTs) and (optionally) an APNs .p8 (to send generic pushes). It calls
 * the license server for web ownership and heartbeat decisions. No database,
 * private license signing key, prompt content, or session keys live here.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `[relay] Missing required env var: ${name}. ` +
        `Set it in Railway (or .env for local dev). See .env.example.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** Railway commonly stores multi-line PEMs with literal `\n`; normalize them. */
function normalizePem(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function loadPublicKeyPem(): string {
  const pem = normalizePem(required('LICENSE_PUBLIC_KEY'));
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error(
      '[relay] LICENSE_PUBLIC_KEY must be an SPKI PEM (-----BEGIN PUBLIC KEY-----). ' +
        'It is the PUBLIC half of the license server signing key.',
    );
  }
  return pem;
}

/** APNs is optional — push is best-effort. Returns null when not fully configured. */
function loadApns(): {
  keyP8: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: 'sandbox' | 'production';
} | null {
  const keyP8Raw = process.env.APNS_KEY_P8?.trim();
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  if (!keyP8Raw || !keyId || !teamId) return null;
  const rawEnv = process.env.APNS_ENV?.trim().toLowerCase();
  const environment: 'sandbox' | 'production' =
    rawEnv === 'production' || rawEnv === 'prod' ? 'production' : 'sandbox';
  return {
    keyP8: normalizePem(keyP8Raw),
    keyId,
    teamId,
    bundleId: optional('APNS_BUNDLE_ID', 'com.marquisehurtt.o8mobile'),
    environment,
  };
}

const DEFAULT_MAX_TUNNEL_BYTES = 32 * 1024 * 1024; // 32MB
const DEFAULT_LICENSE_SERVER_BASE_URL =
  'https://o8-license-server-production.up.railway.app';

function loadMaxTunnelBytes(): number {
  const parsed = Number.parseInt(optional('RELAY_MAX_TUNNEL_BYTES', String(DEFAULT_MAX_TUNNEL_BYTES)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TUNNEL_BYTES;
}

export const env = {
  LICENSE_PUBLIC_KEY: loadPublicKeyPem(),
  ISSUER: optional('ISSUER', 'o8-license'),
  LICENSE_SERVER_BASE_URL: optional(
    'LICENSE_SERVER_BASE_URL',
    DEFAULT_LICENSE_SERVER_BASE_URL,
  ).replace(/\/+$/, ''),
  APNS: loadApns(),
  MAX_TUNNEL_BYTES: loadMaxTunnelBytes(),
  PORT: Number.parseInt(optional('PORT', '8080'), 10),
} as const;

export type Env = typeof env;
