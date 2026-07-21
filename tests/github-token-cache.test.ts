import { describe, expect, it } from 'vitest';

import {
  INSTALLATION_TOKEN_REFRESH_SKEW_MS,
  isInstallationTokenReusable,
} from '../services/license-server/src/github-token-cache';

describe('managed GitHub installation token cache', () => {
  const now = Date.parse('2026-07-21T12:00:00.000Z');

  it('reuses a token outside the replacement window', () => {
    const expiresAt = new Date(now + INSTALLATION_TOKEN_REFRESH_SKEW_MS + 1).toISOString();
    expect(isInstallationTokenReusable(expiresAt, now)).toBe(true);
  });

  it('mints a replacement at the 15-minute boundary', () => {
    const expiresAt = new Date(now + INSTALLATION_TOKEN_REFRESH_SKEW_MS).toISOString();
    expect(isInstallationTokenReusable(expiresAt, now)).toBe(false);
  });

  it('rejects malformed expiry values', () => {
    expect(isInstallationTokenReusable('not-a-date', now)).toBe(false);
  });
});
