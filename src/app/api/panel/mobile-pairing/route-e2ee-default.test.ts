/**
 * #2404 — real-path guard on what an UNCONFIGURED desktop hands a phone.
 *
 * The sibling route.test.ts mocks `mobileE2eeEnabled` to true, so it proves the
 * handler behaves when the flag is on and says nothing about what the flag
 * actually returns in the field. Nothing in the repo sets `O8_MOBILE_E2EE`, so
 * the unset case IS every desktop. This file leaves the flag module real and
 * deletes the variable, and fails on the old default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  resolveRequestPrincipal: vi.fn(),
}));

vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: h.resolveRequestPrincipal }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ apiPort: 47100, wsPort: 47105 }) }));
vi.mock('@/lib/panel/lan-ip', () => ({
  pickMobilePairingHosts: () => [
    { host: '100.64.0.1', kind: 'tailscale' },
    { host: '192.0.2.10', kind: 'lan' },
  ],
}));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'OPERATOR-WS-TOKEN' }));
vi.mock('@/lib/mobile/device-registry', () => ({ createEnrollCode: () => 'ENROLL-CODE' }));
vi.mock('@/lib/mobile/e2ee-identity', () => ({ getServerIdentityPublicKey: () => 'SIDENT-PUB' }));
// Deliberately NOT mocking @/lib/mobile/e2ee-flag — the real default is the
// thing under test.

const { GET } = await import('./route');

const original = process.env.O8_MOBILE_E2EE;

function req() {
  return new NextRequest('http://127.0.0.1/api/panel/mobile-pairing');
}

beforeEach(() => {
  h.resolveRequestPrincipal.mockReset();
  delete process.env.O8_MOBILE_E2EE;
});

afterEach(() => {
  vi.clearAllMocks();
  if (original === undefined) delete process.env.O8_MOBILE_E2EE;
  else process.env.O8_MOBILE_E2EE = original;
});

describe('GET /api/panel/mobile-pairing on an unconfigured desktop', () => {
  it('hands the operator QR an enroll code and the pinned identity', async () => {
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();

    // Without these two the phone stores a config with no
    // serverIdentityPublicKey, which is the only mobile-side gate on relay
    // eligibility and on recoverPairingConfig probing for a moved port or
    // address. That pairing dies on the first drift, QR re-scan the only cure.
    expect(body.enroll).toBe('ENROLL-CODE');
    expect(body.sIdent).toBe('SIDENT-PUB');
  });

  it('still lists every address the Mac answers at', async () => {
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();

    expect(body.host).toBe('100.64.0.1');
    expect(body.hosts).toEqual(['100.64.0.1', '192.0.2.10']);
  });

  it('keeps the device credential boundary — no ws-token, no fresh enroll code', async () => {
    h.resolveRequestPrincipal.mockReturnValue('device');
    const body = await (await GET(req())).json();

    // Turning the flag on must not widen what a DEVICE principal receives.
    expect(body.token).toBe('');
    expect(body.enroll).toBeUndefined();
    expect(body.sIdent).toBeUndefined();
    expect(body.hosts).toEqual(['100.64.0.1', '192.0.2.10']);
  });

  it('honours an explicit opt-out', async () => {
    process.env.O8_MOBILE_E2EE = 'off';
    h.resolveRequestPrincipal.mockReturnValue('operator');
    const body = await (await GET(req())).json();

    expect(body.enroll).toBeUndefined();
    expect(body.sIdent).toBeUndefined();
    expect(body.token).toBe('OPERATOR-WS-TOKEN');
  });
});
