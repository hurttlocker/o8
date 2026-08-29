import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

import { getDataDir } from '@/lib/data-dir-migration';
import { RECEIPT_IDENTITY_FILENAME } from './receipt-identity';

export const RECEIPT_PUBLIC_KEY_FILENAME = 'receipt-public.key';

function keyText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const key = parsed.publicKey ?? parsed.publicKeyB64;
    return typeof key === 'string' ? key.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeReceiptPublicKey(value: string): string {
  const decoded = naclUtil.decodeBase64(keyText(value));
  if (decoded.length === nacl.sign.publicKeyLength) return naclUtil.encodeBase64(decoded);
  if (decoded.length === nacl.sign.secretKeyLength) {
    return naclUtil.encodeBase64(decoded.subarray(nacl.sign.secretKeyLength - nacl.sign.publicKeyLength));
  }
  throw new Error('Receipt key must contain a base64 Ed25519 public key.');
}

export function resolveReceiptPublicKey(value?: string | null): string | null {
  if (value?.trim()) {
    const candidate = value.trim();
    const raw = existsSync(candidate) ? readFileSync(candidate, 'utf8') : candidate;
    return normalizeReceiptPublicKey(raw);
  }

  const dataDir = getDataDir();
  for (const filename of [RECEIPT_PUBLIC_KEY_FILENAME, RECEIPT_IDENTITY_FILENAME]) {
    const candidate = path.join(dataDir, filename);
    if (!existsSync(candidate)) continue;
    return normalizeReceiptPublicKey(readFileSync(candidate, 'utf8'));
  }
  return null;
}
