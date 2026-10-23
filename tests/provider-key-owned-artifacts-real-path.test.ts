import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', home: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('node:os', async real => ({ ...await real<typeof import('node:os')>(), homedir: () => state.home }));
state.home = mkdtempSync(join(tmpdir(), 'o8-owned-provider-artifacts-')); state.dir = join(state.home, 'data');
const key = 'fixture-owned-artifact-provider';
const master = Buffer.alloc(32, 102).toString('base64url');
const request = (body: unknown, method = 'POST') => new NextRequest('http://localhost/api/v2/keys', { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  rmSync(state.dir, { recursive: true, force: true }); mkdirSync(state.dir, { recursive: true });
  vi.stubEnv('O8_MASTER_KEY', master);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { recursive: true, force: true }); });

it('API opt-in never materializes provider secrets and restarted Node mutation scrubs refreshed owned copies', async () => {
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const keys = await import('@/app/api/v2/keys/route');
  saveRuntimeBillingMode('hermes', 'api');
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  // This destination cannot be rediscovered after restart; ownership must be durable.
  const custom = join(state.home, 'external-profile.json');
  writeOwnedRuntimeArtifact(custom, 'hermes', JSON.stringify({ OPENAI_API_KEY: key, oauth: { type: 'oauth', access: 'fixture-oauth' }, service: { headers: { Authorization: 'fixture-service' } } }));
  expect(readFileSync(custom, 'utf8')).not.toContain(key);
  expect(readFileSync(join(state.dir, 'owned-credential-artifacts.json'), 'utf8')).not.toContain('fixture-oauth');
  // Simulate a previous CLI version or refreshed owned auth reintroducing a provider value.
  writeFileSync(custom, JSON.stringify({ OPENAI_API_KEY: key, oauth: { type: 'oauth', access: 'fixture-refreshed-oauth' }, service: { headers: { Authorization: 'fixture-service' } } }));
  vi.resetModules(); const restarted = await import('@/app/api/v2/keys/route');
  expect((await restarted.DELETE(request({ provider: 'openai' }, 'DELETE'))).status).toBe(200);
  expect(JSON.parse(readFileSync(custom, 'utf8'))).toEqual({ oauth: { type: 'oauth', access: 'fixture-refreshed-oauth' }, service: { headers: { Authorization: 'fixture-service' } } });
});

it('the actual child launch revalidates an unregistered owned home without editing the operator source', async () => {
  const home = join(state.dir, 'codex-orchestrator', 'legacy'); mkdirSync(home, { recursive: true });
  const file = join(home, 'config.toml');
  writeFileSync(file, `[model_providers.openai.http_headers]\nAuthorization="Bearer ${key}"\n`);
  const { providerSpawnEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync: launch } = await import('@/lib/providers/child-process');
  const output = launch(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(process.env.CODEX_HOME,"config.toml"),"utf8"))'], { encoding: 'utf8', env: providerSpawnEnvironment({ CODEX_HOME: home }, { runtimeId: 'codex' }) });
  expect(output).not.toContain(key);
  expect(output).toContain('env_http_headers');
  expect(readFileSync(join(state.dir, 'owned-credential-artifacts.json'), 'utf8')).toContain('"owner":"o8"');
});

it('a tampered registry path fails closed before credential deletion or operator file mutation', async () => {
  const keys = await import('@/app/api/v2/keys/route');
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const owned = join(state.home, 'tamper-owned.json');
  writeOwnedRuntimeArtifact(owned, 'codex', JSON.stringify({ api_key: key }));
  const source = join(state.home, 'operator-source.json'); writeFileSync(source, JSON.stringify({ api_key: key }));
  const registry = join(state.dir, 'owned-credential-artifacts.json');
  const records = JSON.parse(readFileSync(registry, 'utf8')); records[0].path = source;
  writeFileSync(registry, JSON.stringify(records));
  const previous = readFileSync(join(state.dir, '.env.local'), 'utf8');
  expect((await keys.DELETE(request({ provider: 'openai' }, 'DELETE'))).status).toBe(503);
  expect(readFileSync(source, 'utf8')).toContain(key);
  expect(readFileSync(join(state.dir, '.env.local'), 'utf8')).toBe(previous);
});


it('API mutation preserves unrelated search and MCP credentials in owned artifacts', async () => {
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const keys = await import('@/app/api/v2/keys/route');
  const file = join(state.home, 'service-config.json');
  const services = { tools: { web: { search: { apiKey: 'fixture-brave', BRAVE_API_KEY: 'fixture-brave' } } }, mcpServers: { search: { env: { SEARCH_API_KEY: 'fixture-search', MCP_API_KEY: 'fixture-mcp', GITHUB_TOKEN: 'fixture-github' } } } };
  writeOwnedRuntimeArtifact(file, 'openclaw', JSON.stringify(services));
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(services);
});

it('leaves deferred Solo supervisor homes unchanged during ordinary API mutations', async () => {
  const keys = await import('@/app/api/v2/keys/route');
  const home = join(state.dir, 'codex-orchestrator', 'fixture', '.single-turns', 'turn', 'codex-home');
  mkdirSync(home, { recursive: true });
  const raw = JSON.stringify({ OPENAI_API_KEY: key });
  writeFileSync(join(home, 'auth.json'), raw);
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(raw);
});
