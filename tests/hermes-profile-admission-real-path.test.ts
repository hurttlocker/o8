import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn as previousVersionSpawn } from 'node:child_process';

const state = vi.hoisted(() => ({ home: '', data: '', next: 0 }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.home }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.data }));
const root = mkdtempSync(join(tmpdir(), 'o8-hermes-admission-'));
const saved = 'fixture-managed-provider-credential';
beforeEach(async () => {
  vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  state.home = join(root, String(++state.next)); state.data = join(state.home, 'data');
  mkdirSync(state.data, { recursive: true });
  vi.stubEnv('HOME', state.home); vi.stubEnv('HERMES_HOME', '');
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 79).toString('base64url'));
  const { mutateProviderKey } = await import('@/lib/providers/key-store');
  mutateProviderKey('OPENAI_API_KEY', { key: saved });
});
afterAll(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function launch(home: string, runtimeId = 'hermes') {
  const peer = join(state.home, 'peer.cjs');
  writeFileSync(peer, `const fs=require('node:fs'),p=require('node:path');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const home=process.env.HERMES_HOME||p.join(process.env.HOME,'.hermes');const files=['config.yaml','.env','auth.json'].flatMap(name=>{try{return [fs.readFileSync(p.join(home,name),'utf8')]}catch{return []}}).join('\\n');if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'fixture',configOptions:[{id:'observed',currentValue:JSON.stringify({env:!!process.env.OPENAI_API_KEY||!!process.env.CODEX_API_KEY||!!process.env.LLM_API_KEY,savedFile:files.includes(${JSON.stringify(saved)}),oauth:files.includes('fixture-account-access'),service:files.includes('fixture-search-service')})}]}:{}}));});`);
  const { AcpClient } = await import('@/lib/acp/client');
  const client = new AcpClient({ runtimeId, command: process.execPath, args: [peer], cwd: state.home, env: { HERMES_HOME: home } });
  try {
    await client.initialize(); const session = await client.newSession(state.home, []);
    return { client, observed: JSON.parse(session.configOptions[0].currentValue!) };
  } catch (error) { client.kill(); throw error; }
}
async function registerLegacy(file: string) {
  const { encryptValueSync } = await import('@/lib/db/master-key');
  const payload = encryptValueSync(JSON.stringify({ owner: 'o8', runtime: 'hermes', path: realpathSync(file), contents: '{}' }));
  writeFileSync(join(state.data, 'owned-credential-artifacts.json'), JSON.stringify([{ owner: 'o8', runtime: 'hermes', path: realpathSync(file), replacement: `enc:${payload.iv}:${payload.ciphertext}` }]));
}

it('fresh Hermes seeding launches on subscription with no saved key in the actual child environment or profile', async () => {
  const source = join(state.home, '.hermes'); mkdirSync(source);
  const config = `model:\n  provider: openai\n  api_key: ${saved}\n`;
  const env = `OPENAI_API_KEY=${saved}\nBRAVE_API_KEY=fixture-search-service\n`;
  const auth = JSON.stringify({ OPENAI_API_KEY: saved, account: { type: 'oauth', access: 'fixture-account-access' } });
  for (const [name, raw] of [['config.yaml', config], ['.env', env], ['auth.json', auth]]) writeFileSync(join(source, name), raw);
  const { prepareHermesWorkerHome } = await import('@/lib/hermes/worker-profile');
  const { hermesHome } = prepareHermesWorkerHome(join(state.data, 'session'));
  const run = await launch(hermesHome);
  try {
    expect(run.observed).toEqual({ env: false, savedFile: false, oauth: true, service: true });
    for (const name of ['config.yaml', '.env', 'auth.json']) expect(readFileSync(join(hermesHome, name), 'utf8')).not.toContain(saved);
    expect(readFileSync(join(source, 'config.yaml'), 'utf8')).toBe(config);
    expect(readFileSync(join(source, '.env'), 'utf8')).toBe(env);
    expect(readFileSync(join(source, 'auth.json'), 'utf8')).toBe(auth);
    const receipts = readdirSync(join(state.data, 'runtime-profile-processes')).map(name => JSON.parse(readFileSync(join(state.data, 'runtime-profile-processes', name), 'utf8')));
    expect(receipts).toContainEqual(expect.objectContaining({ owner: 'o8', pid: run.client.pid, apiAllowedAtLaunch: false, profiles: [realpathSync(hermesHome)] }));
  } finally { run.client.kill(); }
});

it('an operator-owned Hermes profile launches byte-for-byte unchanged even when its own file uses the same provider value', async () => {
  const home = join(state.home, 'operator-profile'); mkdirSync(home);
  const file = join(home, 'auth.json'), raw = JSON.stringify({ OPENAI_API_KEY: saved, account: { access: 'fixture-account-access' } });
  writeFileSync(file, raw);
  const run = await launch(home);
  try {
    expect(run.observed).toMatchObject({ env: false, savedFile: true, oauth: true });
    expect(readFileSync(file, 'utf8')).toBe(raw);
    const { childEnvironment } = await import('@/lib/providers/spawn-environment');
    const { execFileSync } = await import('@/lib/providers/child-process');
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.OPENAI_API_KEY||!!process.env.LLM_API_KEY))'], { encoding: 'utf8', env: childEnvironment({ runtimeId: 'claude-code' }) })).toBe('false');
    expect(readFileSync(file, 'utf8')).toBe(raw);
  } finally { run.client.kill(); }
});

it('refuses only the contaminated legacy o8 file and names the file, manual remedy, and design issue', async () => {
  const home = join(state.home, 'legacy-profile'); mkdirSync(home);
  const file = join(home, 'auth.json'), raw = JSON.stringify({ OPENAI_API_KEY: saved });
  writeFileSync(file, raw); await registerLegacy(file);
  let error: unknown; try { const run = await launch(home); run.client.kill(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(file);
  expect(String(error)).toMatch(/remove.*saved|saved.*remove/i);
  expect(String(error)).toContain('https://github.com/hurttlocker/o8/issues/4340');
  expect(String(error)).not.toContain(saved);
  expect(readFileSync(file, 'utf8')).toBe(raw);
});

it('a registered legacy profile without saved material launches, and manual credential removal unblocks a contaminated one', async () => {
  const home = join(state.home, 'clean-legacy'); mkdirSync(home);
  const file = join(home, 'auth.json'); writeFileSync(file, '{}'); await registerLegacy(file);
  const first = await launch(home); first.client.kill();
  writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: saved }));
  await expect(launch(home)).rejects.toThrow(/#4340/);
  writeFileSync(file, '{}');
  const cleared = await launch(home);
  try { expect(cleared.observed).toMatchObject({ env: false, savedFile: false }); } finally { cleared.client.kill(); }
});

it('an unauthenticated ownership claim does not turn an operator profile into an o8 artifact', async () => {
  const home = join(state.home, 'operator-profile'); mkdirSync(home);
  const file = join(home, 'auth.json'), raw = JSON.stringify({ OPENAI_API_KEY: saved }); writeFileSync(file, raw);
  writeFileSync(join(state.data, 'owned-credential-artifacts.json'), JSON.stringify([{ owner: 'o8', runtime: 'hermes', path: realpathSync(file), replacement: 'invalid' }]));
  const run = await launch(home);
  try { expect(readFileSync(file, 'utf8')).toBe(raw); } finally { run.client.kill(); }
});

it('refuses a clean profile while an o8-recorded API child is alive, then allows it after that child exits', async () => {
  const home = join(state.home, 'profile'); mkdirSync(home); writeFileSync(join(home, 'auth.json'), '{}');
  const child = previousVersionSpawn(process.execPath, ['-e', "console.log('ready');process.stdin.resume()"], { env: { NODE_ENV: 'test', OPENAI_API_KEY: saved }, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = await once(child.stdout, 'data'); expect(String(ready[0])).toContain('ready');
  const { probeMetadataLockProcessIdentitySync } = await import('@/lib/worktree/metadata-lock-process-identity');
  const proof = probeMetadataLockProcessIdentitySync(child.pid!); expect(proof.state).toBe('live');
  const directory = join(state.data, 'runtime-profile-processes'); mkdirSync(directory, { recursive: true });
  // Emulate a persisted explicit launch-mode receipt, never infer it from today's billing setting.
  writeFileSync(join(directory, 'previous-api.json'), JSON.stringify({ version: 1, owner: 'o8', runtimeId: 'hermes', pid: child.pid, processIdentity: proof.state === 'live' ? proof.identity : null, profiles: [home], apiAllowedAtLaunch: true }));
  try {
    await expect(launch(home)).rejects.toThrow(/API.*still running/i);
    const other = join(state.home, 'other-profile'); mkdirSync(other);
    const clean = await launch(other); clean.client.kill();
  } finally { const closed = once(child, 'close'); child.kill(); await closed; }
  const retried = await launch(home);
  try { expect(retried.observed).toMatchObject({ env: false, savedFile: false }); } finally { retried.client.kill(); }
});

it('resolves operator profile aliases against the actual child cwd without a blanket path refusal', async () => {
  const home = join(state.home, 'profile'); mkdirSync(home);
  const alias = join(state.home, 'profile-alias'); symlinkSync(home, alias);
  for (const selected of ['profile', alias]) { const run = await launch(selected); run.client.kill(); }
});

it('governed Hermes commands override ambient HERMES_HOME and leave the operator profile unchanged', async () => {
  const home = join(state.home, '.hermes'); mkdirSync(home); writeFileSync(join(home, 'config.yaml'), 'model: {provider: openai}\n');
  const operator = join(state.home, 'operator'); mkdirSync(operator); writeFileSync(join(operator, 'config.yaml'), 'operator-owned\n');
  vi.stubEnv('HERMES_HOME', operator);
  const bin = join(state.home, 'hermes-cli.cjs');
  writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');const home=process.env.HERMES_HOME||p.join(process.env.HOME,'.hermes');if(process.argv.includes('disable'))fs.writeFileSync(p.join(home,'disabled.json'),'true');else for(const name of ['delegation','terminal','file','code_execution','browser','computer_use'])console.log('✗ disabled '+name);`);
  const { chmodSync } = await import('node:fs'); chmodSync(bin, 0o700);
  const { governHermesProfile } = await import('@/lib/lane/orchestrator-backends/hermes-profile');
  const governed = governHermesProfile(bin);
  expect(governed).not.toBeNull();
  expect(readdirSync(operator)).toEqual(['config.yaml']);
  expect(readFileSync(join(operator, 'config.yaml'), 'utf8')).toBe('operator-owned\n');
  expect(readFileSync(join(governed!.home, '.hermes', 'disabled.json'), 'utf8')).toBe('true');
});

it('a PID-only record cannot refuse an unrelated live process after PID reuse', async () => {
  const home = join(state.home, 'profile'); mkdirSync(home);
  const directory = join(state.data, 'runtime-profile-processes'); mkdirSync(directory);
  writeFileSync(join(directory, 'unproven.json'), JSON.stringify({ version: 1, owner: 'o8', runtimeId: 'hermes', pid: process.pid, processIdentity: null, profiles: [home], apiAllowedAtLaunch: true }));
  const run = await launch(home); run.client.kill();
});


it('retargeting a historical o8 path does not claim ownership of the operator target', async () => {
  const home = join(state.home, 'legacy'); mkdirSync(home);
  const file = join(home, 'auth.json'); writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: saved })); await registerLegacy(file);
  const operator = join(state.home, 'operator'); renameSync(home, operator); symlinkSync(operator, home);
  const before = readFileSync(join(operator, 'auth.json'), 'utf8');
  const run = await launch(operator);
  try { expect(readFileSync(join(operator, 'auth.json'), 'utf8')).toBe(before); } finally { run.client.kill(); }
});

it('governance never runs a mutating Hermes command through a profile link into operator state', async () => {
  const operator = join(state.home, '.hermes'); mkdirSync(operator); writeFileSync(join(operator, 'config.yaml'), 'operator-owned\n');
  const home = join(state.data, 'hermes-o8'); mkdirSync(home); symlinkSync(operator, join(home, '.hermes'));
  const before = readFileSync(join(operator, 'config.yaml'), 'utf8');
  const { governHermesProfile } = await import('@/lib/lane/orchestrator-backends/hermes-profile');
  expect(governHermesProfile(process.execPath)).toBeNull();
  expect(readdirSync(operator)).toEqual(['config.yaml']);
  expect(readFileSync(join(operator, 'config.yaml'), 'utf8')).toBe(before);
});

it('a generic ACP identity still checks the implicit HOME legacy file when another selector is present', async () => {
  const implicit = join(state.home, '.hermes'); mkdirSync(implicit);
  const file = join(implicit, 'auth.json'); writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: saved })); await registerLegacy(file);
  const explicit = join(state.home, 'clean-explicit'); mkdirSync(explicit);
  await expect(launch(explicit, 'acp')).rejects.toThrow(/#4340/);
  const concrete = await launch(explicit, 'hermes'); concrete.client.kill();
});

it('the real child boundary records API permission and prevents file-profile admission while that child can write', async () => {
  const home = join(state.home, 'shared-profile'); mkdirSync(home);
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('claude-code', 'api');
  const { childEnvironment } = await import('@/lib/providers/spawn-environment');
  const { spawn } = await import('@/lib/providers/child-process');
  const child = spawn(process.execPath, ['-e', "const fs=require('node:fs'),p=require('node:path');const key=process.env.OPENAI_API_KEY;console.log('ready');const timer=setInterval(()=>fs.writeFileSync(p.join(process.env.CLAUDE_CONFIG_DIR,'auth.json'),JSON.stringify({OPENAI_API_KEY:key})),20);process.stdin.resume();process.stdin.on('end',()=>{clearInterval(timer);process.exit(0)});"], {
    env: childEnvironment({ runtimeId: 'claude-code', env: { CLAUDE_CONFIG_DIR: home } }), stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout, 'data');
    const receipts = readdirSync(join(state.data, 'runtime-profile-processes')).map(name => JSON.parse(readFileSync(join(state.data, 'runtime-profile-processes', name), 'utf8')));
    expect(receipts).toContainEqual(expect.objectContaining({ pid: child.pid, apiAllowedAtLaunch: true, profiles: [realpathSync(home)] }));
    await expect(launch(home)).rejects.toThrow(/API.*still running/i);
  } finally { const closed = once(child, 'close'); child.kill(); await closed; }
});
