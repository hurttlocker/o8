/**
 * VAPID key generation + management for Web Push.
 *
 * Keys live at $DATA_DIR/vapid.json (mode 0600). Generated on first use.
 * Public key is embedded in the mobile client at subscription time; private
 * key signs the JWT in the Authorization header on each push send.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import 'server-only';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  generateKeyPairSync,
  createSign,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { getDataDir } from '@/lib/data-dir-migration';

interface VapidKeysOnDisk {
  /** Base64url-encoded uncompressed P-256 public key (65 bytes) */
  publicKey: string;
  /** Base64url-encoded raw P-256 private key (32 bytes) */
  privateKey: string;
  /** mailto: URL for the contact field of the JWT */
  subject: string;
  generatedAt: string;
}

export interface VapidKeys {
  publicKeyBase64Url: string;
  privateKeyBase64Url: string;
  subject: string;
  privateKeyObject: KeyObject;
  publicKeyObject: KeyObject;
}

let _cached: VapidKeys | null = null;


function getVapidFilePath(): string {
  return path.join(getDataDir(), 'vapid.json');
}

function defaultSubject(): string {
  // RFC 8292 recommends a mailto: URL. We use a stable per-machine value.
  // Users can override via O8_VAPID_SUBJECT.
  return process.env.O8_VAPID_SUBJECT || 'mailto:o8-local@localhost';
}

/** base64url encoding without padding (per RFC 7515) */
export function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const base64 = str.replaceAll('-', '+').replaceAll('_', '/') + pad;
  return Buffer.from(base64, 'base64');
}

/**
 * Convert a Node.js KeyObject (P-256 EC private key) to its raw 32-byte scalar
 * representation, base64url-encoded. Required by the VAPID JWK format.
 */
function privateKeyToRawBase64Url(privateKeyObj: KeyObject): string {
  const jwk = privateKeyObj.export({ format: 'jwk' });
  if (!jwk.d) throw new Error('[push-vapid] private key missing d component');
  return jwk.d as string;
}

/**
 * Convert a Node.js KeyObject (P-256 EC public key) to the uncompressed
 * 65-byte form (0x04 || x || y), base64url-encoded.
 */
function publicKeyToRawBase64Url(publicKeyObj: KeyObject): string {
  const jwk = publicKeyObj.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('[push-vapid] public key missing x/y components');
  const x = base64UrlDecode(jwk.x as string);
  const y = base64UrlDecode(jwk.y as string);
  const buf = Buffer.concat([Buffer.from([0x04]), x, y]);
  return base64UrlEncode(buf);
}

/**
 * Reconstruct a Node.js KeyObject from a base64url-encoded raw private/public
 * key pair (the form we persist on disk and ship to clients).
 */
function rawToKeyObjects(rawPrivateBase64Url: string, rawPublicBase64Url: string): {
  privateKeyObject: KeyObject;
  publicKeyObject: KeyObject;
} {
  const pubBytes = base64UrlDecode(rawPublicBase64Url);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('[push-vapid] public key is not a 65-byte uncompressed P-256 point');
  }
  const x = base64UrlEncode(pubBytes.subarray(1, 33));
  const y = base64UrlEncode(pubBytes.subarray(33, 65));

  const publicJwk = { kty: 'EC', crv: 'P-256', x, y };
  const privateJwk = { ...publicJwk, d: rawPrivateBase64Url };

  const publicKeyObject = createPublicKey({ key: publicJwk, format: 'jwk' });
  const privateKeyObject = createPrivateKey({ key: privateJwk, format: 'jwk' });
  return { publicKeyObject, privateKeyObject };
}

function generateAndPersist(): VapidKeysOnDisk {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const onDisk: VapidKeysOnDisk = {
    publicKey: publicKeyToRawBase64Url(publicKey),
    privateKey: privateKeyToRawBase64Url(privateKey),
    subject: defaultSubject(),
    generatedAt: new Date().toISOString(),
  };

  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const file = getVapidFilePath();
  writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf-8');
  // Mode 0600 — private key must not be world-readable.
  try {
    chmodSync(file, 0o600);
  } catch {
    // Some filesystems (Windows / network mounts) reject chmod — best-effort.
  }
  console.log('[push-vapid] generated new VAPID keypair');
  return onDisk;
}

function loadFromDisk(): VapidKeysOnDisk | null {
  const file = getVapidFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as VapidKeysOnDisk;
    if (!parsed.publicKey || !parsed.privateKey) return null;
    return parsed;
  } catch (error) {
    console.warn('[push-vapid] failed to read vapid.json — regenerating', error);
    return null;
  }
}

/**
 * Returns the VAPID keys for this o8 install. Generates on first call,
 * persists to ~/.o8/vapid.json, and caches in-process.
 *
 * Allows env override via O8_VAPID_PUBLIC_KEY + O8_VAPID_PRIVATE_KEY (both
 * base64url-encoded, raw form). Useful for shared deployments.
 */
export function getVapidKeys(): VapidKeys {
  if (_cached) return _cached;

  let onDisk: VapidKeysOnDisk | null = null;

  if (process.env.O8_VAPID_PUBLIC_KEY && process.env.O8_VAPID_PRIVATE_KEY) {
    onDisk = {
      publicKey: process.env.O8_VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.O8_VAPID_PRIVATE_KEY.trim(),
      subject: defaultSubject(),
      generatedAt: 'env',
    };
  } else {
    onDisk = loadFromDisk() ?? generateAndPersist();
  }

  const { publicKeyObject, privateKeyObject } = rawToKeyObjects(onDisk.privateKey, onDisk.publicKey);

  _cached = {
    publicKeyBase64Url: onDisk.publicKey,
    privateKeyBase64Url: onDisk.privateKey,
    subject: onDisk.subject,
    publicKeyObject,
    privateKeyObject,
  };
  return _cached;
}

/**
 * Build a VAPID JWT for the Authorization header on a push request.
 *
 * Per RFC 8292: ES256 over { typ: JWT, alg: ES256 } / { aud, exp, sub }.
 * `aud` is the origin of the push endpoint ('https://fcm.googleapis.com').
 * `exp` MUST be ≤ 24h in the future.
 */
export function buildVapidJwt(audience: string, ttlSeconds = 12 * 60 * 60): string {
  const keys = getVapidKeys();
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    sub: keys.subject,
  };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // ES256: sign SHA-256 hash with the EC private key. Node's createSign emits
  // a DER-encoded ECDSA signature; we have to convert it to the JOSE r||s
  // 64-byte raw form.
  const sign = createSign('SHA256');
  sign.update(signingInput);
  sign.end();
  const derSig = sign.sign(keys.privateKeyObject);
  const rawSig = derToRawEcdsa(derSig);

  return `${signingInput}.${base64UrlEncode(rawSig)}`;
}

/**
 * Convert a DER-encoded ECDSA signature (Node's default output) into the raw
 * 64-byte r||s form required by JOSE.
 *
 * DER format: 30 <total-len> 02 <r-len> <r-bytes> 02 <s-len> <s-bytes>
 */
function derToRawEcdsa(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error('[push-vapid] invalid DER signature');
  let offset = 2;
  // Handle long-form length (>= 0x80) — for P-256 this is rare but possible.
  if ((der[1] & 0x80) !== 0) {
    offset = 2 + (der[1] & 0x7f);
  }
  if (der[offset] !== 0x02) throw new Error('[push-vapid] invalid DER r marker');
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (der[offset] !== 0x02) throw new Error('[push-vapid] invalid DER s marker');
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);

  // Strip leading zero padding (added when high bit of r/s would otherwise
  // flip the DER sign), then pad to 32 bytes.
  if (r.length > 32) r = r.subarray(r.length - 32);
  if (s.length > 32) s = s.subarray(s.length - 32);
  const rPadded = Buffer.alloc(32);
  const sPadded = Buffer.alloc(32);
  r.copy(rPadded, 32 - r.length);
  s.copy(sPadded, 32 - s.length);
  return Buffer.concat([rPadded, sPadded]);
}
