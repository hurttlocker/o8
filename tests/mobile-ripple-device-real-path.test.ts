import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({
  resolveOpenRouterRoute: async () => ({ url: 'https://inference.invalid/fixture', headers: {}, model: 'fixture' }),
}));

const { createEnrollCode, resolveDeviceByToken, revokeDevice } = await import('@/lib/mobile/device-registry');
const { POST: enroll } = await import('@/app/api/mobile/enroll/route');
const { POST: resolveRipple } = await import('@/app/api/mobile/ripple/resolve/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb } = await import('@/lib/db');
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const workerToken = 'fixture-worker-token';
const spectatorToken = 'fixture-spectator-token';
writeFileSync(path.join(dataDir, 'worker-token'), workerToken);
writeFileSync(path.join(dataDir, 'broadcast-spectator-tokens'), createHash('sha256').update(spectatorToken).digest('hex'));

function request(token?: string, method = 'POST', pathname = '/api/mobile/ripple/resolve') {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ utterance: 'fix the target' }) } : {}),
  });
}

describe('paired-device Ripple request through enrollment, persisted principal, gate, and route', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => closeDb());

  it('admits only the paired-device POST and revokes it with the device', async () => {
    const enrollment = await enroll(new NextRequest('http://localhost:3001/api/mobile/enroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enroll: createEnrollCode(Date.now()), identityPublicKey: 'fixture-device-identity' }),
    }));
    expect(enrollment.status).toBe(200);
    const { deviceToken } = await enrollment.json();
    const device = resolveDeviceByToken(deviceToken)!;
    expect(device.revokedAt).toBeNull();
    expect(readFileSync(path.join(dataDir, 'mobile-device-tokens'), 'utf8')).toContain(createHash('sha256').update(deviceToken).digest('hex'));

    const req = request(deviceToken);
    expect(panelGateMiddleware(req).status).toBe(200);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      kind: 'choice', question: 'Which target?', options: [{ label: 'Client', value: 'client' }, { label: 'Server', value: 'server' }], aodlPath: 'intent.target',
    }) } }] })));
    const response = await resolveRipple(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'choice', aodlPath: 'intent.target' });

    expect(panelGateMiddleware(request()).status).toBe(401);
    for (const token of [workerToken, spectatorToken]) expect(panelGateMiddleware(request(token)).status).toBe(403);
    for (const method of ['GET', 'PATCH', 'DELETE', 'PUT']) expect(panelGateMiddleware(request(deviceToken, method)).status).toBe(403);
    expect(panelGateMiddleware(request(deviceToken, 'POST', '/api/mobile/ripple/resolve/extra')).status).toBe(403);
    expect(revokeDevice(device.id)).toBe(true);
    expect(resolveDeviceByToken(deviceToken)).toBeNull();
    expect(panelGateMiddleware(request(deviceToken)).status).toBe(401);
  });
});
