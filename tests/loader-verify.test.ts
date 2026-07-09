import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type VerifyIdentityResponse = (json: unknown, expectedBootId?: string) => boolean;

function loadVerifier(): VerifyIdentityResponse {
  const source = readFileSync(join(process.cwd(), 'scripts', 'loader-verify.mjs'), 'utf-8')
    .replace(/export\s*\{\s*verifyIdentityResponse\s*\};?\s*$/m, '');
  const factory = new Function(`${source}; return verifyIdentityResponse;`);
  return factory() as VerifyIdentityResponse;
}

const verifyIdentityResponse = loadVerifier();

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
