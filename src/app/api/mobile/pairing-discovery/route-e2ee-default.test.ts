/**
 * #2404 — the recovery endpoint on an UNCONFIGURED desktop.
 *
 * The sibling route.test.ts mocks the flag to true. With the real default this
 * route answered 404 on every machine, and it is the only endpoint
 * `recoverPairingConfig` has: a 404 from every candidate port means the phone
 * concludes the desktop is gone and tells the operator to re-scan the QR. So
 * port recovery — and the address recovery built on it in o8-mobile#57 — were
 * switched off in the field regardless of how a phone was paired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/panel/api-port', () => ({
  resolvePortInfo: () => ({ apiPort: 47100, wsPort: 47105 }),
}));
vi.mock('@/lib/mobile/e2ee-identity', () => ({
  getServerIdentity: () => ({ secretKey: new Uint8Array(64) }),
}));
vi.mock('@/lib/mobile/e2ee-crypto', () => ({
  signDetached: (message: string) => `sig:${message}`,
}));
// The real flag module — that is the thing under test.

const { GET } = await import('./route');

const original = process.env.O8_MOBILE_E2EE;

function discover(nonce = 'a'.repeat(32)) {
  return new NextRequest(
    `http://127.0.0.1:47100/api/mobile/pairing-discovery?nonce=${nonce}`,
  );
}

beforeEach(() => {
  delete process.env.O8_MOBILE_E2EE;
});

afterEach(() => {
  if (original === undefined) delete process.env.O8_MOBILE_E2EE;
  else process.env.O8_MOBILE_E2EE = original;
});

describe('GET /api/mobile/pairing-discovery on an unconfigured desktop', () => {
  it('answers a paired phone looking for a moved port', async () => {
    const response = await GET(discover());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.apiPort).toBe(47100);
    expect(body.wsPort).toBe(47105);
    expect(typeof body.signature).toBe('string');
  });

  it('carries no bearer or enrollment material', async () => {
    const body = await (await GET(discover())).json();

    // The whole point of this endpoint: a phone probes unknown ports with it
    // before it is willing to send its device token anywhere.
    expect(body.token).toBeUndefined();
    expect(body.enroll).toBeUndefined();
  });

  it('still 404s under an explicit opt-out', async () => {
    process.env.O8_MOBILE_E2EE = 'off';
    expect((await GET(discover())).status).toBe(404);
  });

  it('still rejects a malformed nonce', async () => {
    expect((await GET(discover('short'))).status).toBe(400);
  });
});
