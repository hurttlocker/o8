import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

it('restarted native mutation scrubs registered files plus undiscovered legacy archive, Solo, Hermes and OpenClaw fields', async () => {
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const custom = join(state.home, 'native-custom.json');
  writeOwnedRuntimeArtifact(custom, 'codex', JSON.stringify({ oauth: { type: 'oauth', access: 'fixture-oauth' } }));
  writeFileSync(custom, JSON.stringify({ OPENAI_API_KEY: key, oauth: { type: 'oauth', access: 'fixture-new-oauth' } }));
  const fixtures = [
    ['codex-orchestrator/repo/.single-turns/id/codex-home/auth.json', JSON.stringify({ OPENAI_API_KEY: key, tokens: { access_token: 'fixture-oauth' } })],
    ['owned-hermes-archive/session/hermes-home/.env', `OPENAI_API_KEY=${key}\nSERVICE_TOKEN=fixture-service\n`],
    ['hermes-o8/.hermes/config.yaml', `provider: openai\napi_key: ${key}\nservice_token: fixture-service\n`],
    ['codex-orchestrator/repo/config.toml', `[model_providers.openai.http_headers]\nAuthorization="Bearer ${key}"\n`],
  ];
  const openclaw = join(state.home, '.openclaw-o8', 'openclaw.json');
  const source = join(state.home, '.openclaw', 'openclaw.json');
  for (const file of [openclaw, source]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify({ models: { providers: { openai: { apiKey: key, headers: { Authorization: `Bearer ${key}` } } } }, oauth: { type: 'oauth', access: 'fixture-oauth' }, service: { headers: { Authorization: 'fixture-service' } } })); }
  for (const [relative, raw] of fixtures) { const file = join(state.dir, relative); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, raw); }
  execFileSync('cargo', ['build', '--locked', '--manifest-path', resolve('tests/provider-keys/Cargo.toml')], { env: { ...process.env, CARGO_BUILD_JOBS: '2' }, stdio: 'pipe', timeout: 120_000 });
  const binary = resolve(`tests/provider-keys/target/debug/o8-provider-key-tests${process.platform === 'win32' ? '.exe' : ''}`);
  expect(existsSync(binary)).toBe(true);
  const output = execFileSync(binary, { input: JSON.stringify({ action: 'save', pref: 'openrouter_api_key', value: '' }), encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: state.dir, HOME: state.home, O8_MASTER_KEY: master, O8_TEST_DISABLE_VOICE_PROVIDER_KEYS: '1' } });
  expect(JSON.parse(output).ok).toBe(true);
  expect(readFileSync(openclaw, 'utf8')).not.toContain(key);
  expect(readFileSync(source, 'utf8')).toContain(key);
  expect(JSON.parse(readFileSync(openclaw, 'utf8')).oauth.access).toBe('fixture-oauth');
  for (const [relative] of fixtures) expect(readFileSync(join(state.dir, relative), 'utf8')).not.toContain(key);
  expect(JSON.parse(readFileSync(custom, 'utf8'))).toEqual({ oauth: { type: 'oauth', access: 'fixture-new-oauth' } });
  expect(readFileSync(join(state.dir, 'owned-hermes-archive/session/hermes-home/.env'), 'utf8')).toContain('fixture-service');
}, 150_000);

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

it.each(['node', 'native'])('%s restarted mutation strips retired provider bytes from arbitrary MCP fields while retaining service and OAuth auth', async writer => {
  const keys = await import('@/app/api/v2/keys/route');
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  const file = join(state.home, `retired-${writer}.json`);
  writeOwnedRuntimeArtifact(file, 'codex', '{}');
  expect((await keys.DELETE(request({ provider: 'openai' }, 'DELETE'))).status).toBe(200);
  const raw = { mcpServers: { provider: { headers: { Authorization: `Bearer ${key}` }, env: { ARBITRARY_COPY: `prefix:${key}:suffix` }, args: [JSON.stringify({ copied: key }), '--safe'] }, service: { headers: { Authorization: 'Bearer fixture-unrelated-service' } } }, account: { type: 'oauth', access_token: 'fixture-unrelated-oauth' } };
  writeFileSync(file, JSON.stringify(raw));
  const toml = join(state.dir, 'codex-orchestrator', `retired-${writer}`, 'config.toml');
  const envFile = join(state.dir, 'owned-hermes-archive', `retired-${writer}`, 'hermes-home', '.env');
  for (const file of [toml, envFile]) mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(toml, `# retired provider copy: ${key}\nmodel="fixture-model"\n`);
  writeFileSync(envFile, `SERVICE_AUTH='Bearer ${key}'\nSERVICE_TOKEN='fixture-unrelated-service'\n`);
  if (writer === 'node') {
    vi.resetModules(); const restarted = await import('@/app/api/v2/keys/route');
    expect((await restarted.POST(request({ provider: 'openrouter', key: 'fixture-next-unrelated-key' }))).status).toBe(200);
  } else {
    execFileSync('cargo', ['build', '--locked', '--manifest-path', resolve('tests/provider-keys/Cargo.toml')], { env: { ...process.env, CARGO_BUILD_JOBS: '2' }, stdio: 'pipe', timeout: 120_000 });
    const binary = resolve(`tests/provider-keys/target/debug/o8-provider-key-tests${process.platform === 'win32' ? '.exe' : ''}`);
    const result = execFileSync(binary, { input: JSON.stringify({ action: 'save', pref: 'openrouter_enabled', value: false }), encoding: 'utf8', env: { ...process.env, O8_DATA_DIR: state.dir, HOME: state.home, O8_MASTER_KEY: master, O8_TEST_DISABLE_VOICE_PROVIDER_KEYS: '1' } });
    expect(JSON.parse(result).ok).toBe(true);
  }
  expect(readFileSync(toml, 'utf8')).not.toContain(key);
  expect(readFileSync(toml, 'utf8')).toContain('fixture-model');
  expect(readFileSync(envFile, 'utf8')).not.toContain(key);
  expect(readFileSync(envFile, 'utf8')).toContain('fixture-unrelated-service');
  const scrubbed = readFileSync(file, 'utf8'); expect(scrubbed).not.toContain(key);
  const parsed = JSON.parse(scrubbed);
  expect(parsed.mcpServers.provider).toEqual({ headers: {}, env: {}, args: ['--safe'] });
  expect(parsed.mcpServers.service).toEqual(raw.mcpServers.service);
  expect(parsed.account).toEqual(raw.account);
}, 150_000);
