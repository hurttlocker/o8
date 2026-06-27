import { describe, expect, it } from 'vitest';

import { createEnrollCode, consumeEnrollCode, hashToken } from '@/lib/mobile/device-registry';

/**
 * #5 mobile E2EE — enroll-code lifecycle + token hashing (the pure, DB-free
 * half). The DB-backed registry round-trip (enroll → resolve → revoke) is
 * covered by tests/smoke/mobile-device-registry-smoke.ts against a temp DB.
 */
describe('#5 enroll codes', () => {
  const NOW = 1_000_000;

  it('mints a code that validates once then is consumed (single-use)', () => {
    const code = createEnrollCode(NOW);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(consumeEnrollCode(code, NOW + 1000)).toBe(true);
    expect(consumeEnrollCode(code, NOW + 2000)).toBe(false); // already consumed
  });

  it('rejects an expired code (past the 5-min TTL)', () => {
    const code = createEnrollCode(NOW);
    expect(consumeEnrollCode(code, NOW + 5 * 60 * 1000 + 1)).toBe(false);
  });

  it('rejects unknown / empty codes', () => {
    expect(consumeEnrollCode('deadbeef', NOW)).toBe(false);
    expect(consumeEnrollCode('', NOW)).toBe(false);
  });
});

describe('#5 token hashing', () => {
  it('is deterministic sha256 hex and never echoes the token', () => {
    const h = hashToken('abc123');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashToken('abc123'));
    expect(h).not.toContain('abc123');
    expect(hashToken('abc123')).not.toBe(hashToken('abc124'));
  });
});
