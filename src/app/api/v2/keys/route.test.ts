import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({ dir: '', denied: false, invalidate: vi.fn() }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => state.denied ? NextResponse.json({ error: 'unauthorized' }, { status: 401 }) : null }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ invalidateRuntimeAuthCache: state.invalidate }));
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 19).toString('base64url'));
state.dir = mkdtempSync(join(tmpdir(), 'o8-keys-test-'));
const routes = await import('./route');
const { clearMasterKeyCache } = await import('@/lib/db/master-key');
const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/v2/keys', { method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 19).toString('base64url')); clearMasterKeyCache();
  vi.stubEnv('OPENROUTER_API_KEY', ''); state.denied = false;
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  writeFileSync(join(state.dir, '.env.local'), '# preserve\nUNRELATED=value\n');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { rmSync(state.dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearMasterKeyCache(); });
it('saves an encrypted key, masks inventory, and really removes its persisted line', async () => {
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-test-key' }))).status).toBe(200);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toContain('OPENROUTER_API_KEY=enc:');
  expect(JSON.stringify(await (await routes.GET(request('GET'))).json())).not.toContain('synthetic-test-key');
  expect((await routes.DELETE(request('DELETE', { provider: 'openrouter' }))).status).toBe(200);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).not.toMatch(/^OPENROUTER_API_KEY=/m);
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
const recordPath = () => join(state.dir, 'providers', 'openrouter.json');
const keyStatus = (status: number, data: Record<string, unknown> = {}) => vi.fn(async () => status === 200
  ? Response.json({ data: { usage: 1.5, usage_daily: 0.25, limit: 10, limit_remaining: 8.5, is_free_tier: false, ...data } })
  : Response.json({ error: { code: status } }, { status }));
const openRouterView = async () => {
  const payload = await (await routes.GET(request('GET'))).json() as { providers: Array<{ id: string; connection?: Record<string, unknown> }> };
  return payload.providers.find((provider) => provider.id === 'openrouter')?.connection;
};
it('keeps the key check result so a connected key reports its state and figures without its secret', async () => {
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  vi.stubGlobal('fetch', keyStatus(200));
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-connected-key' }))).status).toBe(200);
  const view = await openRouterView();
  expect(view).toMatchObject({ state: 'connected', enabled: true, lastError: null, details: { usageDaily: 0.25, limitRemaining: 8.5, isFreeTier: false } });
  expect(readFileSync(recordPath(), 'utf8')).not.toContain('synthetic-connected-key');
  expect(JSON.stringify(view)).not.toContain('synthetic-connected-key');
});
it('rejects a key OpenRouter refuses and saves an unchecked key as unverified', async () => {
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  vi.stubGlobal('fetch', keyStatus(401));
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-rejected-key' }))).status).toBe(400);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).not.toMatch(/^OPENROUTER_API_KEY=/m);
  for (const status of [402, 429, 500]) {
    vi.stubGlobal('fetch', keyStatus(status));
    const response = await routes.POST(request('POST', { provider: 'openrouter', key: `synthetic-unchecked-${status}` }));
    const body = await response.json() as { warning?: string; connection?: { state: string; lastError: string } };
    expect(response.status).toBe(200);
    expect(body.warning).toContain('unverified');
    expect(body.connection).toMatchObject({ state: 'configured-unverified' });
    expect(body.connection?.lastError).toContain(String(status));
  }
});
it('turns the connection off without deleting the key, refuses checks while off, and keeps the choice across removal', async () => {
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  vi.stubGlobal('fetch', keyStatus(200));
  await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-toggle-key' }));
  const off = await routes.PATCH(request('PATCH', { provider: 'openrouter', enabled: false }));
  expect(off.status).toBe(200);
  expect((await off.json() as { connection: { state: string } }).connection.state).toBe('disabled');
  expect(process.env.OPENROUTER_API_KEY).toBeFalsy();
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toContain('OPENROUTER_API_KEY=enc:');
  expect((await routes.PATCH(request('PATCH', { provider: 'openrouter', check: true }))).status).toBe(409);
  vi.mocked(fetch).mockClear();
  expect((await openRouterView())?.state).toBe('disabled');
  expect(fetch).not.toHaveBeenCalled();
  await routes.DELETE(request('DELETE', { provider: 'openrouter' }));
  expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toMatchObject({ enabled: false, keyFingerprint: null, details: null });
  const on = await routes.PATCH(request('PATCH', { provider: 'openrouter', enabled: true }));
  expect((await on.json() as { connection: { state: string } }).connection.state).toBe('disconnected');
});
it('re-checks a connected key on request and marks a later failure as degraded', async () => {
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  vi.stubGlobal('fetch', keyStatus(200));
  await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-recheck-key' }));
  vi.stubGlobal('fetch', keyStatus(429));
  const checked = await routes.PATCH(request('PATCH', { provider: 'openrouter', check: true }));
  const body = await checked.json() as { connection: { state: string; lastError: string; details: { usageDaily: number } } };
  expect(body.connection.state).toBe('degraded');
  expect(body.connection.lastError).toContain('429');
  expect(body.connection.details.usageDaily).toBe(0.25);
  expect((await routes.PATCH(request('PATCH', { provider: 'unknown', enabled: false }))).status).toBe(400);
  state.denied = true;
  expect((await routes.PATCH(request('PATCH', { provider: 'openrouter', enabled: false }))).status).toBe(401);
});

it('preserves encrypted credentials and connection state when the store cannot decrypt', async () => {
  rmSync(join(state.dir, 'providers'), { recursive: true, force: true });
  await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-protected-key' }));
  const original = readFileSync(join(state.dir, '.env.local'), 'utf8');
  const connection = readFileSync(recordPath(), 'utf8');
  // Exercise real AES decryption failure against the already persisted store.
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 20).toString('base64url')); clearMasterKeyCache();
  for (const [method, body] of [
    ['POST', { provider: 'openrouter', key: 'synthetic-replacement' }],
    ['DELETE', { provider: 'openrouter' }],
    ['PATCH', { provider: 'openrouter', enabled: false }],
    ['PATCH', { provider: 'openrouter', check: true }],
  ] as const) {
    const response = await routes[method](request(method, body));
    expect(response.status).toBe(503);
    expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toBe(original);
    expect(readFileSync(recordPath(), 'utf8')).toBe(connection);
  }
});

it.each(['openai', 'anthropic', 'deepseek', 'gemini', 'groq', 'elevenlabs', 'google_tts'])('saves, checks, disables and removes the %s provider without an account', async (provider) => {
  expect((await routes.POST(request('POST', { provider, key: 'synthetic-provider-key' }))).status).toBe(200);
  expect((await routes.PATCH(request('PATCH', { provider, check: true }))).status).toBe(200);
  expect((await routes.PATCH(request('PATCH', { provider, enabled: false }))).status).toBe(200);
  expect((await routes.PATCH(request('PATCH', { provider, check: true }))).status).toBe(409);
  expect((await routes.DELETE(request('DELETE', { provider }))).status).toBe(200);
});
it('never checks a provider key with a model completion', async () => {
  await routes.POST(request('POST', { provider: 'anthropic', key: 'synthetic-provider-key' }));
  expect(fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'synthetic-provider-key' }) }));
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('encrypts supported legacy plaintext without copying project configuration', async () => {
  writeFileSync(join(state.dir, '.env.local'), '# preserve\nGROQ_API_KEY=fixture-legacy-groq\nUNRELATED=value\n');
  expect((await routes.POST(request('POST', { provider: 'openrouter', key: 'synthetic-migrating-key' }))).status).toBe(200);
  const raw = readFileSync(join(state.dir, '.env.local'), 'utf8');
  expect(raw).toMatch(/^GROQ_API_KEY=enc:/m);
  expect(raw).not.toContain('fixture-legacy-groq');
  expect(raw).toContain('UNRELATED=value');
});

it('disabling an ambient provider preserves its environment credential for re-enable', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-ambient-openai');
  expect((await routes.PATCH(request('PATCH', { provider: 'openai', enabled: false }))).status).toBe(200);
  expect(process.env.OPENAI_API_KEY).toBe('fixture-ambient-openai');
  await routes.PATCH(request('PATCH', { provider: 'openai', enabled: true }));
  expect((await routes.PATCH(request('PATCH', { provider: 'openai', check: true }))).status).toBe(200);
});
