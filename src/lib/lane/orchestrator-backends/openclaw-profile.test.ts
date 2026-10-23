import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.data }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
state.home = mkdtempSync(join(tmpdir(), 'o8-openclaw-billing-')); state.data = join(state.home, 'data'); mkdirSync(state.data);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const { prepareOpenclawProfile } = await import('./openclaw-profile');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
const source = join(state.home, '.openclaw'); const owned = join(state.home, '.openclaw-o8');
const auth = 'agents/main/agent/auth-profiles.json';
const oauth = { type: 'oauth', provider: 'openai-codex', access: 'fixture-oauth-access', refresh: 'fixture-oauth-refresh' };
beforeEach(() => {
  rmSync(join(state.data, 'runtime-billing'), { recursive: true, force: true }); rmSync(owned, { recursive: true, force: true });
  writeFileSync(join(state.data, '.env.local'), '');
  mkdirSync(join(source, 'agents/main/agent'), { recursive: true });
  writeFileSync(join(source, 'openclaw.json'), JSON.stringify({ agents: { list: [{ id: 'main' }] }, models: { providers: { openai: { apiKey: 'fixture-source-key' }, constructor: { apiKey: 'fixture-prototype-bypass' } } }, service: { headers: { apiKey: 'fixture-service-token' } }, mcp: { servers: { o8: {} } } }));
  writeFileSync(join(source, auth), JSON.stringify({ profiles: { api: { type: 'api_key', provider: 'openai', key: 'fixture-source-key' }, account: oauth } }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 71).toString('base64url'));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { recursive: true, force: true }); });
it('subscription overlays exclude API keys while preserving account OAuth and source profiles', async () => {
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-key' }))).status).toBe(200);
  prepareOpenclawProfile(34123);
  expect(readFileSync(join(owned, 'openclaw.json'), 'utf8')).not.toContain('fixture-saved-key');
  expect(readFileSync(join(owned, 'openclaw.json'), 'utf8')).not.toContain('fixture-prototype-bypass');
  expect(JSON.parse(readFileSync(join(owned, auth), 'utf8')).profiles.account).toEqual(oauth);
  expect(JSON.parse(readFileSync(join(owned, 'openclaw.json'), 'utf8')).service.headers.apiKey).toBe('fixture-service-token');
  expect(readFileSync(join(owned, auth), 'utf8')).not.toContain('fixture-source-key');
  expect(readFileSync(join(source, auth), 'utf8')).toContain('fixture-source-key');
});
it('API overlays reconcile removal after a fresh module load without rewriting unrelated agent state', async () => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'openclaw', mode: 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-key' }))).status).toBe(200);
  prepareOpenclawProfile(34123);
  expect(readFileSync(join(owned, auth), 'utf8')).not.toContain('fixture-saved-key');
  mkdirSync(join(owned, 'agents/main/sessions'), { recursive: true });
  const unrelated = join(owned, 'agents/main/sessions/state.json'); writeFileSync(unrelated, '{"apiKey":"fixture-unrelated-state"}');
  expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  vi.resetModules(); const restarted = await import('./openclaw-profile'); restarted.prepareOpenclawProfile(34123);
  expect(readFileSync(join(owned, auth), 'utf8')).not.toContain('fixture-saved-key');
  expect(readFileSync(join(owned, 'openclaw.json'), 'utf8')).not.toContain('fixture-saved-key');
  expect(readFileSync(join(owned, 'openclaw.json'), 'utf8')).not.toContain('fixture-prototype-bypass');
  expect(JSON.parse(readFileSync(join(owned, auth), 'utf8')).profiles.account).toEqual(oauth);
  expect(JSON.parse(readFileSync(join(owned, 'openclaw.json'), 'utf8')).service.headers.apiKey).toBe('fixture-service-token');
  expect(readFileSync(unrelated, 'utf8')).toBe('{"apiKey":"fixture-unrelated-state"}');
});

it('refuses an intermediate credential-directory link without changing the source', async () => {
  prepareOpenclawProfile(34123);
  const before = readFileSync(join(source, auth), 'utf8');
  rmSync(join(owned, 'agents/main/agent'), { recursive: true });
  symlinkSync(join(source, 'agents/main/agent'), join(owned, 'agents/main/agent'), 'dir');
  expect(() => prepareOpenclawProfile(34123)).toThrow(/cannot follow links/);
  expect(readFileSync(join(source, auth), 'utf8')).toBe(before);
});
it('refuses a linked owned profile root before writing the source config', () => {
  const before = readFileSync(join(source, 'openclaw.json'), 'utf8');
  symlinkSync(source, owned, 'dir');
  expect(() => prepareOpenclawProfile(34123)).toThrow(/cannot follow links/);
  expect(readFileSync(join(source, 'openclaw.json'), 'utf8')).toBe(before);
});

it.each(['subscription', 'api', 'disable', 'remove'])('provider headers honor %s while MCP service headers remain intact', async action => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'openclaw', mode: action === 'subscription' ? 'subscription' : 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-header-key' }))).status).toBe(200);
  const file = join(source, 'openclaw.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.models.providers.openai.headers = { Authorization: 'Bearer fixture-source-key', 'x-api-key': 'fixture-source-key', 'OpenAI-Organization': 'fixture-org' };
  config.service.headers = { Authorization: 'Bearer fixture-mcp-service', 'x-api-key': 'fixture-mcp-service' };
  writeFileSync(file, JSON.stringify(config));
  if (action === 'disable') expect((await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH'))).status).toBe(200);
  if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  prepareOpenclawProfile(34123);
  const copied = JSON.parse(readFileSync(join(owned, 'openclaw.json'), 'utf8'));
  expect(copied.models.providers.openai.headers).toEqual({ 'OpenAI-Organization': 'fixture-org' });
  expect(copied.service.headers).toEqual(config.service.headers);
  expect(readFileSync(file, 'utf8')).toContain('fixture-source-key');
});
