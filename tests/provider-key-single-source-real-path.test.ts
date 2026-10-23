import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => fixture.data }));
fixture.home = mkdtempSync(join(tmpdir(), 'o8-single-auth-'));
fixture.data = join(fixture.home, 'data');
const source = join(fixture.home, '.codex');
mkdirSync(source); mkdirSync(fixture.data);
const { childEnvironment } = await import('@/lib/providers/spawn-environment');
const { execFileSync } = await import('@/lib/providers/child-process');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const launch = (script: string, identified = true) => execFileSync(process.execPath, ['-e', script], {
  env: identified ? childEnvironment({ runtimeId: 'codex' }) : { ...process.env }, encoding: 'utf8',
});
const inspect = `const f=require('node:fs'),p=require('node:path'),h=process.env.CODEX_HOME;process.stdout.write(JSON.stringify({home:h,auth:f.existsSync(p.join(h,'auth.json'))?JSON.parse(f.readFileSync(p.join(h,'auth.json'),'utf8')):null}));`;
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 86).toString('base64url'));
  vi.stubEnv('HOME', fixture.home); vi.stubEnv('CODEX_HOME', '');
  rmSync(fixture.data, { force: true, recursive: true }); mkdirSync(fixture.data);
  writeFileSync(join(source, 'config.toml'), '');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, auth_mode: 'chatgpt', tokens: { refresh_token: 'source-refresh' } }));
  mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-single-source-provider' });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(fixture.home, { force: true, recursive: true }); });

it('writes a subscription child refresh through to the source and observes later login and logout', () => {
  const first = JSON.parse(launch(inspect));
  expect(lstatSync(join(first.home, 'auth.json')).isSymbolicLink()).toBe(true);
  expect(existsSync(join(first.home, 'auth-source.sha256'))).toBe(false);
  launch(`require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{refresh_token:'child-refresh'}}));`);
  expect(JSON.parse(readFileSync(join(source, 'auth.json'), 'utf8')).tokens.refresh_token).toBe('child-refresh');
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'operator-login' } }));
  expect(JSON.parse(launch(inspect)).auth.tokens.refresh_token).toBe('operator-login');
  rmSync(join(source, 'auth.json'));
  expect(JSON.parse(launch(inspect)).auth).toBeNull();
});
it('never gives an API child an OAuth file, including after a subscription launch', () => {
  const first = JSON.parse(launch(inspect));
  saveRuntimeBillingMode('codex', 'api');
  const api = JSON.parse(launch(inspect));
  expect(api.auth).toBeNull();
  expect(existsSync(join(api.home, 'auth.json'))).toBe(false);
  expect(readFileSync(join(source, 'auth.json'), 'utf8')).toContain('source-refresh');
  expect(first.home).not.toBe(source);
});
it('isolates implicit and explicit credential homes for an unidentified child while retaining unrelated keys', () => {
  writeFileSync(join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-single-source-provider' }));
  vi.stubEnv('BRAVE_API_KEY', 'fixture-search-service');
  for (const codexHome of ['', source]) {
    vi.stubEnv('CODEX_HOME', codexHome);
    const result = JSON.parse(launch(`process.stdout.write(JSON.stringify(process.env));`, false));
    expect(result.CODEX_HOME).toBeTruthy();
    expect(result.CODEX_HOME).not.toBe(source);
    expect(JSON.parse(readFileSync(join(result.CODEX_HOME, 'auth.json'), 'utf8'))).toEqual({});
    expect(result.HOME).not.toBe(fixture.home);
    for (const name of ['CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'GEMINI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])
      expect(result[name]).toBeTruthy();
    expect(result.BRAVE_API_KEY).toBe('fixture-search-service');
  }
});
it('does not surface YAML unknown-tag values through warnings or errors at profile preparation', async () => {
  const hermes = join(fixture.home, '.hermes'); mkdirSync(hermes, { recursive: true });
  const secret = 'fixture-single-source-provider';
  writeFileSync(join(hermes, 'config.yaml'), `model:\n  provider: openai\n  api_key: !unrecognized ${secret}\n`);
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const { governHermesProfile } = await import('@/lib/lane/orchestrator-backends/hermes-profile');
  let error: unknown;
  try { governHermesProfile(process.execPath); } catch (caught) { error = caught; }
  try {
    expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
    expect(String(error ?? '')).not.toContain(secret);
  } finally { warning.mockRestore(); }
});

it('refuses a mixed API-key/account source without editing the operator file', () => {
  const raw = JSON.stringify({ OPENAI_API_KEY: 'fixture-single-source-provider', tokens: { refresh_token: 'source-refresh' } });
  writeFileSync(join(source, 'auth.json'), raw);
  expect(() => launch(inspect)).toThrow(/subscription authentication contains an API credential/);
  expect(readFileSync(join(source, 'auth.json'), 'utf8')).toBe(raw);
  saveRuntimeBillingMode('codex', 'api');
  expect(JSON.parse(launch(inspect)).auth).toBeNull();
});

it('preserves unrelated global Git and GitHub CLI configuration for utility children', () => {
  writeFileSync(join(fixture.home, '.gitconfig'), '[user]\n  name = Fixture\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', ''); vi.stubEnv('GH_CONFIG_DIR', ''); vi.stubEnv('XDG_CONFIG_HOME', '');
  const name = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' });
  expect(name.trim()).toBe('Fixture');
  const env = JSON.parse(launch('process.stdout.write(JSON.stringify(process.env));', false));
  expect(env.GH_CONFIG_DIR).toBe(join(fixture.home, '.config', 'gh'));
  expect(env.HOME).not.toBe(fixture.home);
});

it('retains the selected account when a nested runtime reenters its prepared home', () => {
  const custom = join(fixture.home, 'custom-account'); mkdirSync(custom);
  writeFileSync(join(custom, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: 'selected-account' } }));
  vi.stubEnv('CODEX_HOME', custom);
  const first = JSON.parse(launch(inspect));
  const again = execFileSync(process.execPath, ['-e', inspect], {
    env: childEnvironment({ runtimeId: 'codex', env: { CODEX_HOME: first.home } }), encoding: 'utf8',
  });
  expect(JSON.parse(again).auth.tokens.refresh_token).toBe('selected-account');
  saveRuntimeBillingMode('codex', 'api');
  const api = JSON.parse(launch(inspect));
  const propagated = { CODEX_HOME: api.home, O8_CODEX_AUTH_SOURCE: custom, O8_CODEX_AUTH_HOME: api.home };
  expect(JSON.parse(execFileSync(process.execPath, ['-e', inspect], {
    env: childEnvironment({ runtimeId: 'codex', env: propagated }), encoding: 'utf8',
  })).auth).toBeNull();
  saveRuntimeBillingMode('codex', 'subscription');
  expect(JSON.parse(execFileSync(process.execPath, ['-e', inspect], {
    env: childEnvironment({ runtimeId: 'codex', env: propagated }), encoding: 'utf8',
  })).auth.tokens.refresh_token).toBe('selected-account');
});
