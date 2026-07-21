import { describe, expect, it } from 'vitest';

import { isAuthorizedClerkParty } from '../services/license-server/src/clerk-authorized-party';

describe('Clerk authorized-party verification', () => {
  const parties = ['https://o8.run'];

  it('accepts a native session token with no azp claim', () => {
    expect(isAuthorizedClerkParty(undefined, parties)).toBe(true);
  });

  it('accepts an exact browser-origin match', () => {
    expect(isAuthorizedClerkParty('https://o8.run', parties)).toBe(true);
  });

  it('rejects a browser origin outside the allowlist', () => {
    expect(isAuthorizedClerkParty('https://evil.example', parties)).toBe(false);
  });

  it('rejects a present origin when the deployment allowlist is empty', () => {
    expect(isAuthorizedClerkParty('https://o8.run', [])).toBe(false);
  });

  it.each([null, '', 42, ['https://o8.run']])('rejects malformed azp value %j', (azp) => {
    expect(isAuthorizedClerkParty(azp, parties)).toBe(false);
  });
});
