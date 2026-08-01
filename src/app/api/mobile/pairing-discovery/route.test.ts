import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  mobileE2eeEnabled: vi.fn(() => true),
  resolvePortInfo: vi.fn(() => ({ apiPort: 47122, wsPort: 47127 })),
  signDetached: vi.fn((message: string) => `sig:${message}`),
}));

vi.mock('@/lib/mobile/e2ee-flag', () => ({ mobileE2eeEnabled: h.mobileE2eeEnabled }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: h.resolvePortInfo }));
vi.mock('@/lib/mobile/e2ee-identity', () => ({ getServerIdentity: () => ({ secretKey: new Uint8Array(64) }) }));
vi.mock('@/lib/mobile/e2ee-crypto', () => ({ signDetached: h.signDetached }));

const { GET } = await import('./route');

describe('GET /api/mobile/pairing-discovery', () => {
  it('returns a nonce-bound, signed current-port proof without a bearer', async () => {
    const response = await GET(new NextRequest(
      'http://192.168.1.50:47122/api/mobile/pairing-discovery?nonce=nonce-for-the-paired-phone',
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      v: 1,
      nonce: 'nonce-for-the-paired-phone',
      apiPort: 47122,
      wsPort: 47127,
      signature: 'sig:o8-e2ee-v1|pairing-discovery|nonce-for-the-paired-phone|47122|47127',
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('rejects a missing nonce and stays unavailable when E2EE is off', async () => {
    const missing = await GET(new NextRequest('http://localhost/api/mobile/pairing-discovery'));
    expect(missing.status).toBe(400);

    h.mobileE2eeEnabled.mockReturnValueOnce(false);
    const disabled = await GET(new NextRequest(
      'http://localhost/api/mobile/pairing-discovery?nonce=nonce-for-the-paired-phone',
    ));
    expect(disabled.status).toBe(404);
  });
});
