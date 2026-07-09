import { describe, expect, it } from 'vitest';

// Import the REAL shipped module (the loader inlines this same file's source at
// build time in tauri-export.mjs). Direct ESM import — no dynamic evaluation.
// The specifier is cast so tsc doesn't demand type declarations for the .mjs.
const { verifyIdentityResponse } = (await import(
  '../scripts/loader-verify.mjs' as string
)) as { verifyIdentityResponse: (json: unknown, expectedBootId?: string) => boolean };

describe('loader identity verification', () => {
  it('rejects foreign 404 or non-JSON payloads', () => {
    expect(verifyIdentityResponse(null, 'boot-a')).toBe(false);
    expect(verifyIdentityResponse('not-json', 'boot-a')).toBe(false);
    expect(verifyIdentityResponse({ status: 404 }, 'boot-a')).toBe(false);
  });

  it('rejects a valid-looking body with the wrong bootId', () => {
    expect(
      verifyIdentityResponse(
        { product: 'o8', instanceId: 'instance-a', bootId: 'boot-b', apiPort: 47100 },
        'boot-a',
      ),
    ).toBe(false);
  });

  it('rejects non-o8 products', () => {
    expect(
      verifyIdentityResponse(
        { product: 'other', instanceId: 'instance-a', bootId: 'boot-a', apiPort: 47100 },
        'boot-a',
      ),
    ).toBe(false);
  });

  it('accepts the current o8 boot identity', () => {
    expect(
      verifyIdentityResponse(
        { product: 'o8', instanceId: 'instance-a', bootId: 'boot-a', apiPort: 47100 },
        'boot-a',
      ),
    ).toBe(true);
  });
});
