/**
 * Mobile E2EE — the server's persistent Ed25519 identity.
 *
 * One long-term signing keypair per o8 install, stored at `~/.o8/e2ee-identity.key`
 * (mode 600). Its public key is delivered to a phone out-of-band via the pairing
 * QR (the desktop screen is a trusted channel) and pinned by the device; the
 * secret key signs the per-connection `e2ee-hello` so a phone can detect a wrong/
 * MITM server. Mirrors the `ws-auth.ts` concurrency-safe create pattern.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import nacl from 'tweetnacl';

import { b64encode, b64decode } from '@/lib/mobile/e2ee-crypto';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
export const E2EE_IDENTITY_PATH = path.join(DATA_DIR, 'e2ee-identity.key');

export interface ServerIdentity {
  /** base64 Ed25519 public key — pinned by paired devices. */
  publicKeyB64: string;
  /** 64-byte Ed25519 secret key — signs the handshake; never leaves the host. */
  secretKey: Uint8Array;
}

let cached: ServerIdentity | null = null;

function readStoredSecret(): Uint8Array | null {
  try {
    if (!existsSync(E2EE_IDENTITY_PATH)) return null;
    const raw = readFileSync(E2EE_IDENTITY_PATH, 'utf8').trim();
    if (!raw) return null;
    const secret = b64decode(raw);
    return secret.length === nacl.sign.secretKeyLength ? secret : null;
  } catch {
    return null;
  }
}

function identityFromSecret(secretKey: Uint8Array): ServerIdentity {
  // Ed25519 public key is the last 32 bytes of the 64-byte secret key.
  const publicKey = secretKey.subarray(32);
  return { publicKeyB64: b64encode(publicKey), secretKey };
}

/** Load (or create on first use) the server's persistent E2EE identity. Cached. */
export function getServerIdentity(): ServerIdentity {
  if (cached) return cached;

  const existing = readStoredSecret();
  if (existing) {
    cached = identityFromSecret(existing);
    return cached;
  }

  const keyPair = nacl.sign.keyPair();
  const encoded = b64encode(keyPair.secretKey);
  mkdirSync(DATA_DIR, { recursive: true });

  try {
    writeFileSync(E2EE_IDENTITY_PATH, encoded, { flag: 'wx', mode: 0o600 });
    console.log(`[mobile-e2ee] Generated server E2EE identity at ${E2EE_IDENTITY_PATH}`);
    cached = identityFromSecret(keyPair.secretKey);
    return cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrent = readStoredSecret();
      if (concurrent) {
        cached = identityFromSecret(concurrent);
        return cached;
      }
    }
    writeFileSync(E2EE_IDENTITY_PATH, encoded, { mode: 0o600 });
    cached = identityFromSecret(keyPair.secretKey);
    return cached;
  }
}

/** Convenience: just the base64 public key for the pairing payload. */
export function getServerIdentityPublicKey(): string {
  return getServerIdentity().publicKeyB64;
}
