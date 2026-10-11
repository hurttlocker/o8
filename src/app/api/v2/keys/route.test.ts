import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({ dir: '', denied: false, invalidate: vi.fn() }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => state.denied ? NextResponse.json({ error: 'unauthorized' }, { status: 401 }) : null }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: state.invalidate }));
vi.mock('@/lib/db/master-key', () => ({ encryptValue: async (value: string) => ({ iv: 'test', ciphertext: Buffer.from(value).toString('hex') }), decryptValue: async (value: string) => Buffer.from(value, 'hex').toString() }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-keys-test-'));
const routes = await import('./route');
const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/v2/keys', { method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', ''); state.denied = false;
  writeFileSync(join(state.dir, '.env.local'), '# preserve\nUNRELATED=value\n');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { rmSync(state.dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('saves an encrypted key, masks inventory, and really removes its persisted line', async () => {
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-test-key' }))).status).toBe(200);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toContain('OPENROUTER_API_KEY=enc:');
  expect(JSON.stringify(await (await routes.GET(request('GET'))).json())).not.toContain('synthetic-test-key');
  expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(200);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).not.toContain('OPENROUTER_API_KEY=');
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toContain('# preserve');
  expect(state.invalidate).toHaveBeenCalled();
});
it('validates OpenRouter using its authenticated key endpoint', async () => {
  await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-test-key' }));
  expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/key', expect.anything());
});
it('rejects invalid payloads and unauthenticated mutations before writing', async () => {
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 42 }))).status).toBe(400);
  state.denied = true;
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'test' }))).status).toBe(401);
  expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(401);
});
