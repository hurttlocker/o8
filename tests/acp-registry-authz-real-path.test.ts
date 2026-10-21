import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', prepare: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/acp/registry-preparation', () => ({ prepareRegistryAgent: state.prepare }));
vi.mock('@/lib/acp/registry', () => ({ readAcpRegistry: state.read }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-acp-registry-auth-'));
const operator = 'fixture-registry-operator-0123456789abcdef';
const worker = 'fixture-registry-worker-0123456789abcdef';
const device = 'fixture-registry-device-0123456789abcdef';
const spectator = 'fixture-registry-spectator-0123456789abcdef';
writeFileSync(join(state.dir, 'ws-token'), operator);
writeFileSync(join(state.dir, 'worker-token'), worker);
for (const [file, value] of [['mobile-device-tokens', device], ['broadcast-spectator-tokens', spectator]]) writeFileSync(join(state.dir, file), createHash('sha256').update(value).digest('hex'));
const { panelGateMiddleware } = await import('@/middleware');
const { POST } = await import('@/app/api/runtime/acp-registry/prepare/route');
const { GET } = await import('@/app/api/runtime/acp-registry/route');
const selection = { id: 'fixture', fingerprint: 'a'.repeat(64) };
const request = (method: string, token?: string, body: unknown = selection) => new NextRequest(`http://example.test/api/runtime/acp-registry${method === 'POST' ? '/prepare' : ''}`, {
  method, headers: { host: 'example.test', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});
beforeEach(() => {
  vi.stubEnv('O8_ACP_COMMAND', ''); state.prepare.mockReset(); state.read.mockReset();
  state.prepare.mockResolvedValue({ name: 'Fixture', command: '/fixture/node', args: [], useOpenRouter: false });
  state.read.mockResolvedValue({ agents: [], stale: false });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });

it('denies non-operator access at the middleware and route boundaries without preparation', async () => {
  for (const token of [undefined, worker, device, spectator]) for (const method of ['GET', 'POST']) {
    const req = request(method, token);
    expect(panelGateMiddleware(req).status).toBe(token ? 403 : 401);
    expect((await (method === 'POST' ? POST(req) : GET(req))).status).toBe(401);
  }
  expect(state.prepare).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled();
});
it('prepares only a validated selection for an authenticated operator without saving it', async () => {
  const req = request('POST', operator);
  expect(panelGateMiddleware(req).status).toBe(200);
  expect((await POST(req)).status).toBe(200);
  expect(state.prepare).toHaveBeenCalledExactlyOnceWith(selection);
  expect((await POST(request('POST', operator, { ...selection, id: '../escape' }))).status).toBe(400);
  vi.stubEnv('O8_ACP_COMMAND', 'environment-agent');
  expect((await POST(request('POST', operator))).status).toBe(409);
  expect(state.prepare).toHaveBeenCalledTimes(1);
});
