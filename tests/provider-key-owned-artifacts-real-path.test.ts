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

it('the actual child launch revalidates an unregistered non-Codex owned home', async () => {
  const home = join(state.dir, 'hermes-o8', 'legacy'); mkdirSync(home, { recursive: true });
  const file = join(home, 'config.yaml');
  writeFileSync(file, `model:\n  provider: openai\n  api_key: ${key}\n`);
  const { providerSpawnEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync: launch } = await import('@/lib/providers/child-process');
  const output = launch(process.execPath, ['-e', 'process.stdout.write(require("node:fs").readFileSync(require("node:path").join(process.env.HERMES_HOME,"config.yaml"),"utf8"))'], { encoding: 'utf8', env: providerSpawnEnvironment({ HERMES_HOME: home }, { runtimeId: 'hermes' }) });
  expect(output).not.toContain(key);
  expect(readFileSync(join(state.dir, 'owned-credential-artifacts.json'), 'utf8')).toContain('"owner":"o8"');
});

it('a tampered registry path fails closed before credential deletion or operator file mutation', async () => {
  const keys = await import('@/app/api/v2/keys/route');
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const owned = join(state.home, 'tamper-owned.json');
  writeOwnedRuntimeArtifact(owned, 'hermes', JSON.stringify({ api_key: key }));
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

it.each(['claude-code', 'gemini'])('revocation still scrubs unregistered owned-%s homes and archives', async runtime => {
  const root = join(state.dir, `owned-${runtime}`);
  const archive = join(state.home, `archive-${runtime}`);
  for (const home of [root, archive, `${archive}-archive`]) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: key, oauth: { access_token: 'fixture-account' } }));
  }
  vi.stubEnv(`O8_OWNED_${runtime.toUpperCase().replaceAll('-', '_')}_ROOT`, archive);
  const keys = await import('@/app/api/v2/keys/route');
  expect((await keys.POST(request({ provider: 'openai', key }))).status).toBe(200);
  for (const home of [root, archive, `${archive}-archive`]) {
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).toEqual({ oauth: { access_token: 'fixture-account' } });
  }
});

it.each([[undefined, false], ['acp', false], ['acp', true]] as const)('ACP identity %s cannot read a saved key through owned HOME (registered/disabled=%s)', async (runtimeId, disabled) => {
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const { AcpClient } = await import('@/lib/acp/client');
  mutateProviderKey('OPENAI_API_KEY', { key });
  const home = join(state.dir, 'hermes-o8');
  const profile = join(home, '.hermes'); mkdirSync(profile, { recursive: true });
  const auth = join(profile, 'auth.json');
  if (disabled) {
    writeOwnedRuntimeArtifact(auth, 'hermes', '{}');
    mutateProviderKey('OPENAI_API_KEY', { enabled: false });
  }
  // A legacy profile, or a late stale write by the preceding API child.
  writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: key, oauth: { access_token: 'fixture-account' } }));
  writeFileSync(join(profile, 'config.yaml'), '');
  const peer = join(state.home, 'owned-home-peer.cjs');
  writeFileSync(peer, `const fs=require('node:fs'),p=require('node:path');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'fixture',configOptions:[{id:'model',type:'select',currentValue:String(JSON.parse(fs.readFileSync(p.join(process.env.HOME,'.hermes','auth.json'),'utf8')).OPENAI_API_KEY!==undefined),options:[]}]}:{}})+'\\n');});`);
  // Exercise the runtime boundary for an untyped caller with no identity too.
  const client = new AcpClient({ runtimeId: runtimeId as string, command: process.execPath, args: [peer], env: { HOME: home } });
  try {
    await client.initialize();
    const session = await client.newSession(state.home, []);
    expect(session.configOptions[0].currentValue).toBe('false');
    expect(JSON.parse(readFileSync(auth, 'utf8'))).toEqual({ oauth: { access_token: 'fixture-account' } });
  } finally { client.kill(); }
});

it.each([['disabled', false], ['removed', false], ['disabled', true], ['removed', true]] as const)('the next unidentified launch scrubs every registered artifact after a key is %s and rewritten (missing during revocation=%s)', async (change, missing) => {
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { writeOwnedRuntimeArtifact } = await import('@/lib/providers/owned-artifacts');
  const { execFileSync: launch } = await import('@/lib/providers/child-process');
  mutateProviderKey('OPENAI_API_KEY', { key });
  const file = join(state.home, 'unselected-owned-profile.json');
  writeOwnedRuntimeArtifact(file, 'hermes', '{}');
  if (missing) rmSync(file);
  mutateProviderKey('OPENAI_API_KEY', change === 'disabled' ? { enabled: false } : { key: null });
  writeFileSync(file, JSON.stringify({ nested: { header: `Bearer ${key}` }, BRAVE_API_KEY: 'fixture-search' }));
  const peer = join(state.home, 'unselected-profile-peer.cjs');
  writeFileSync(peer, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(file)},'utf8'));`);
  const output = JSON.parse(launch(process.execPath, [peer], { encoding: 'utf8', env: { NODE_ENV: 'test' } }));
  expect(output).toEqual({ nested: {}, BRAVE_API_KEY: 'fixture-search' });
  expect(readFileSync(file, 'utf8')).not.toContain(key);
});

it.each(['acp', 'unknown-runtime'])('an API record for generic or unknown identity %s cannot grant credentials to an actual child', async runtimeId => {
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { execFileSync: launch } = await import('@/lib/providers/child-process');
  mutateProviderKey('OPENAI_API_KEY', { key });
  saveRuntimeBillingMode(runtimeId, 'api');
  const output = launch(process.execPath, ['-e', 'process.stdout.write(String(Boolean(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.LLM_API_KEY)))'], {
    env: childEnvironment({ runtimeId, env: { LLM_PROVIDER: 'openai', LLM_API_KEY: key } }), encoding: 'utf8',
  });
  expect(output).toBe('false');
});
