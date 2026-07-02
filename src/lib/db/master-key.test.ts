import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Pin a valid 256-bit key via the env override so the test never touches the
// macOS Keychain and never depends on the (now-removed) static fallback.
beforeAll(async () => {
  process.env.O8_MASTER_KEY = randomBytes(32).toString('base64url');
  const { clearMasterKeyCache } = await import('./master-key');
  clearMasterKeyCache();
});

describe('master-key AES-256-GCM', () => {
  it('round-trips an encrypted value', async () => {
    const { encryptValue, decryptValue } = await import('./master-key');
    const { ciphertext, iv } = await encryptValue('sk-provider-secret');
    expect(await decryptValue(ciphertext, iv)).toBe('sk-provider-secret');
  });

  it('uses a fresh IV per encryption (no GCM nonce reuse)', async () => {
    const { encryptValue } = await import('./master-key');
    const a = await encryptValue('same-plaintext');
    const b = await encryptValue('same-plaintext');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails closed on a tampered ciphertext (auth tag verified)', async () => {
    const { encryptValue, decryptValue } = await import('./master-key');
    const { ciphertext, iv } = await encryptValue('secret');
    const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('00') ? '11' : '00');
    expect(await decryptValue(tampered, iv)).toBeNull();
  });
});
