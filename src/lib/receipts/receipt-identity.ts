/** Dedicated Ed25519 identity for signed packet receipts. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

import { getDataDir } from '@/lib/data-dir-migration';

export const RECEIPT_IDENTITY_FILENAME = 'receipt-identity.key';
export const RECEIPT_IDENTITY_PATH = path.join(getDataDir(), RECEIPT_IDENTITY_FILENAME);

export interface ReceiptIdentity {
  publicKeyB64: string;
  secretKey: Uint8Array;
  keyId: string;
}

export interface ReceiptIdentityCreateHooks {
  /** Test seam for a second process winning the exclusive-create race. */
  beforeExclusiveWrite?: () => void;
}

let cached: ReceiptIdentity | null = null;

function readStoredSecret(identityPath: string): Uint8Array | null {
  try {
    if (!existsSync(identityPath)) return null;
    const raw = readFileSync(identityPath, 'utf8').trim();
    if (!raw) return null;
    const secret = naclUtil.decodeBase64(raw);
    return secret.length === nacl.sign.secretKeyLength ? secret : null;
  } catch {
    return null;
  }
}

function identityFromSecret(secretKey: Uint8Array): ReceiptIdentity {
  const publicKey = secretKey.subarray(32);
  return {
    publicKeyB64: naclUtil.encodeBase64(publicKey),
    secretKey,
    keyId: receiptKeyIdForPublicKey(publicKey),
  };
}

export function receiptKeyIdForPublicKey(publicKey: Uint8Array | string): string {
  const bytes = typeof publicKey === 'string' ? naclUtil.decodeBase64(publicKey) : publicKey;
  if (bytes.length !== nacl.sign.publicKeyLength) {
    throw new Error('Receipt public key must be a 32-byte Ed25519 key.');
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function loadOrCreateReceiptIdentityAt(
  identityPath: string,
  hooks: ReceiptIdentityCreateHooks = {},
): ReceiptIdentity {
  const existing = readStoredSecret(identityPath);
  if (existing) return identityFromSecret(existing);

  const keyPair = nacl.sign.keyPair();
  const encoded = naclUtil.encodeBase64(keyPair.secretKey);
  mkdirSync(path.dirname(identityPath), { recursive: true });
  hooks.beforeExclusiveWrite?.();

  try {
    writeFileSync(identityPath, encoded, { flag: 'wx', mode: 0o600 });
    return identityFromSecret(keyPair.secretKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const concurrent = readStoredSecret(identityPath);
      if (concurrent) return identityFromSecret(concurrent);
      throw new Error(
        `receipt identity exists but is unreadable; refusing to replace the trust root: ${identityPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Load or create the receipt-only identity. The updater identity is never read. */
export function getReceiptIdentity(): ReceiptIdentity {
  cached ??= loadOrCreateReceiptIdentityAt(RECEIPT_IDENTITY_PATH);
  return cached;
}

export function getReceiptIdentityPublicKey(): string {
  return getReceiptIdentity().publicKeyB64;
}

export function signReceiptBytes(message: Uint8Array, secretKey: Uint8Array): string {
  return naclUtil.encodeBase64(nacl.sign.detached(message, secretKey));
}

export function verifyReceiptBytes(
  message: Uint8Array,
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  try {
    return nacl.sign.detached.verify(
      message,
      naclUtil.decodeBase64(signatureB64),
      naclUtil.decodeBase64(publicKeyB64),
    );
  } catch {
    return false;
  }
}
