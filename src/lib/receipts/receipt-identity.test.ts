import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadOrCreateReceiptIdentityAt,
  signReceiptBytes,
  verifyReceiptBytes,
} from './receipt-identity';

const temporaryDirectories: string[] = [];

function identityPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'o8-receipt-identity-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'receipt-identity.key');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('receipt identity', () => {
  it('creates a dedicated key file with owner-only permissions', () => {
    const file = identityPath();
    const identity = loadOrCreateReceiptIdentityAt(file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(identity.keyId).toMatch(/^[a-f0-9]{16}$/);
    expect(naclUtil.decodeBase64(identity.publicKeyB64)).toHaveLength(nacl.sign.publicKeyLength);
  });

  it('uses the winner when another process wins the exclusive-create race', () => {
    const file = identityPath();
    const winner = nacl.sign.keyPair();
    const identity = loadOrCreateReceiptIdentityAt(file, {
      beforeExclusiveWrite: () => {
        writeFileSync(file, naclUtil.encodeBase64(winner.secretKey), { flag: 'wx', mode: 0o600 });
      },
    });

    expect(identity.publicKeyB64).toBe(naclUtil.encodeBase64(winner.publicKey));
    expect(loadOrCreateReceiptIdentityAt(file).publicKeyB64).toBe(identity.publicKeyB64);
  });

  it('signs and verifies bytes with the receipt identity only', () => {
    const identity = loadOrCreateReceiptIdentityAt(identityPath());
    const other = loadOrCreateReceiptIdentityAt(identityPath());
    const message = new TextEncoder().encode('{"schema":"o8/packet-receipt/v1"}');
    const signature = signReceiptBytes(message, identity.secretKey);

    expect(verifyReceiptBytes(message, signature, identity.publicKeyB64)).toBe(true);
    expect(verifyReceiptBytes(message, signature, other.publicKeyB64)).toBe(false);
  });
});
