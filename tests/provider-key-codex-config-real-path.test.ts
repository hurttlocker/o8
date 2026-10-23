import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.data }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
state.home = mkdtempSync(join(tmpdir(), 'o8-codex-provider-headers-')); state.data = join(state.home, 'data');
mkdirSync(state.data); mkdirSync(join(state.home, '.codex'));
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const { prepareCodexHome } = await import('@/lib/lane/codex-orchestrator-config');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  writeFileSync(join(state.data, '.env.local'), ''); rmSync(join(state.data, 'runtime-billing'), { recursive: true, force: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 84).toString('base64url')); vi.stubEnv('OPENAI_API_KEY', 'fixture-inherited-key');
  vi.stubEnv('CUSTOM_PROVIDER_API_KEY', 'fixture-source-key');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { recursive: true, force: true }); });
it.each(['subscription', 'api', 'disable', 'remove'])('Codex config writer filters provider http_headers and env_http_headers for %s', async action => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: action === 'subscription' ? 'subscription' : 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-header-key' }))).status).toBe(200);
  const source = join(state.home, '.codex/config.toml');
  const provider = {
    http_headers: { Authorization: 'Bearer fixture-source-key', 'OpenAI-Organization': 'fixture-org' },
    env_http_headers: { Authorization: 'OPENAI_API_KEY', 'x-api-key': 'CUSTOM_PROVIDER_API_KEY', 'OpenAI-Organization': 'ORG_ID' },
  };
  writeFileSync(source, stringify({ model_providers: { openai: provider }, service: { http_headers: { Authorization: 'Bearer fixture-service-token' }, env_http_headers: { Authorization: 'SERVICE_TOKEN' } } }));
  if (action === 'disable') expect((await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH'))).status).toBe(200);
  if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  const prepared = prepareCodexHome(state.home);
  const copied = parse(readFileSync(join(prepared.codexHome, 'config.toml'), 'utf8')) as {
    model_providers: { openai: typeof provider }; service: unknown;
  };
  expect(copied.model_providers.openai.http_headers).toEqual({ 'OpenAI-Organization': 'fixture-org' });
  expect(copied.model_providers.openai.env_http_headers).toEqual({ Authorization: 'OPENAI_API_KEY', 'OpenAI-Organization': 'ORG_ID' });
  expect(readFileSync(join(prepared.codexHome, 'config.toml'), 'utf8')).not.toContain('fixture-saved-header-key');
  expect(copied.service).toEqual({ http_headers: { Authorization: 'Bearer fixture-service-token' }, env_http_headers: { Authorization: 'SERVICE_TOKEN' } });
  expect(readFileSync(source, 'utf8')).toContain('fixture-source-key');
});

it('custom provider headers never acquire the runtime default provider key', async () => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-saved-header-key' }))).status).toBe(200);
  writeFileSync(join(state.home, '.codex/config.toml'), stringify({ model_providers: { custom: {
    base_url: 'https://provider.example.invalid', http_headers: { Authorization: 'Bearer fixture-custom-key', 'X-Organization': 'fixture-org' },
  } } }));
  const prepared = prepareCodexHome(state.home);
  const copied = parse(readFileSync(join(prepared.codexHome, 'config.toml'), 'utf8')) as { model_providers: { custom: { http_headers: unknown } } };
  expect(copied.model_providers.custom.http_headers).toEqual({ 'X-Organization': 'fixture-org' });
});

it('keeps unrelated service API keys in an imported config', () => {
  writeFileSync(join(state.home, '.codex/config.toml'), stringify({ service: { api_key: 'fixture-service', BRAVE_API_KEY: 'fixture-brave', GITHUB_TOKEN: 'fixture-github' }, mcp_servers: { search: { command: 'search', env: { SEARCH_API_KEY: 'fixture-search', MCP_API_KEY: 'fixture-mcp' } } } }));
  const prepared = prepareCodexHome(state.home);
  const copied = parse(readFileSync(join(prepared.codexHome, 'config.toml'), 'utf8')) as Record<string, unknown>;
  expect(copied.service).toEqual({ api_key: 'fixture-service', BRAVE_API_KEY: 'fixture-brave', GITHUB_TOKEN: 'fixture-github' });
});
