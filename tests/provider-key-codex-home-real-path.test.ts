import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ home: '', dir: '' }));
vi.mock('node:os', async real => ({ ...await real<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.home = mkdtempSync(join(tmpdir(), 'o8-codex-home-policy-')); state.dir = join(state.home, 'data');
const source = join(state.home, '.codex'); mkdirSync(source); mkdirSync(state.dir);
const observed = join(state.home, 'observed.json');
const binary = join(state.home, 'fixture-codex');
const inspect = `const fs=require('node:fs'),p=require('node:path');const home=process.env.CODEX_HOME||${JSON.stringify(source)};fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({home,config:fs.readFileSync(p.join(home,'config.toml'),'utf8'),auth:fs.existsSync(p.join(home,'auth.json'))?JSON.parse(fs.readFileSync(p.join(home,'auth.json'),'utf8')):null,sqlite:process.env.CODEX_SQLITE_HOME,sessions:fs.realpathSync(p.join(home,'sessions'))}));`;
writeFileSync(binary, `#!/usr/bin/env node\n${inspect}`); chmodSync(binary, 0o755);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { execFileSync } = await import('@/lib/providers/child-process');
const { CodexAppServerClient } = await import('@/lib/codex/app-server-client');
const request = (path: string, body: unknown) => new NextRequest(`http://localhost/api/${path}`, { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(async () => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 112).toString('base64url'));
  vi.stubEnv('HOME', state.home);
  vi.stubEnv('CODEX_HOME', '');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
  writeFileSync(join(source, 'config.toml'), '[model_providers.openai.http_headers]\nAuthorization="Bearer fixture-source-provider"\n');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fixture-oauth' } }));
  mkdirSync(join(source, 'sessions'), { recursive: true });
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-source-provider' }))).status).toBe(200);
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.home, { recursive: true, force: true }); });
it.each(['subscription', 'api'] as const)('isolates %s Codex app-server credentials while retaining shared session state', async mode => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode }))).status).toBe(200);
  await new Promise<void>(resolve => { new CodexAppServerClient({ binaryPath: binary, codexHome: source, onExit: () => resolve() }); });
  const result = JSON.parse(readFileSync(observed, 'utf8'));
  expect(result.home).not.toBe(source);
  expect(result.config).not.toContain('fixture-source-provider');
  expect(result.auth).toEqual(mode === 'subscription' ? { tokens: { access_token: 'fixture-oauth' } } : null);
  expect(result.sqlite).toBe(source); expect(result.sessions).toBe(realpathSync(join(source, 'sessions')));
  expect(JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8'))).toEqual({ tokens: { access_token: 'fixture-oauth' } });
});
it('isolates the implicit Codex home at the actual ordinary child boundary', async () => {
  await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: 'subscription' }));
  execFileSync(binary, [], { env: childEnvironment({ runtimeId: 'codex' }) });
  const result = JSON.parse(readFileSync(observed, 'utf8'));
  expect(result.home).not.toBe(source); expect(result.auth.OPENAI_API_KEY).toBeUndefined();
});

it('treats an identity source inside the data directory as borrowed configuration', () => {
  const identity = join(state.dir, 'identity-source'); mkdirSync(identity);
  const raw = '[model_providers.openai.http_headers]\nAuthorization="Bearer fixture-source-provider"\n';
  for (const name of ['config.toml', 'managed_config.toml', 'requirements.toml']) writeFileSync(join(identity, name), raw);
  const result = execFileSync(process.execPath, ['-e', 'const fs=require("node:fs"),p=require("node:path");process.stdout.write(JSON.stringify([process.env.CODEX_HOME,...["config.toml","managed_config.toml","requirements.toml"].map(n=>fs.readFileSync(p.join(process.env.CODEX_HOME,n),"utf8"))]));'], { encoding: 'utf8', env: childEnvironment({ runtimeId: 'codex', env: { CODEX_HOME: identity } }) });
  const [home, ...configs] = JSON.parse(result) as string[];
  expect(home).not.toBe(identity);
  for (const config of configs) expect(config).not.toContain('fixture-source-provider');
  for (const name of ['config.toml', 'managed_config.toml', 'requirements.toml']) expect(readFileSync(join(identity, name), 'utf8')).toBe(raw);
});
