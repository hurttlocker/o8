import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-child-boundary-'));
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { childEnvironment, internalBrokerEnvironment } = await import('@/lib/providers/spawn-environment');
const cp = await import('@/lib/providers/child-process');
const script = join(state.dir, 'observe.cjs');
const output = join(state.dir, 'observed.json');
writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify([process.env.OPENAI_API_KEY ?? null, process.env.LOGIN_COPY ?? null]));`);
beforeEach(() => {
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 99).toString('base64url'));
  vi.stubEnv('OPENAI_API_KEY', 'fixture-boundary-key'); vi.stubEnv('LOGIN_COPY', 'fixture-boundary-key');
  writeFileSync(join(state.dir, '.env.local'), '');
  mutateProviderKey('OPENAI_API_KEY', { key: 'fixture-boundary-key' });
  saveRuntimeBillingMode('codex', 'subscription');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['spawnSync', 'execFileSync', 'execSync', 'spawn', 'execFile', 'promisified', 'fork'])('%s rejects implicit ambient provider credentials', async operation => {
  if (operation === 'spawnSync') expect(cp.spawnSync(process.execPath, [script]).status).toBe(0);
  else if (operation === 'execFileSync') cp.execFileSync(process.execPath, [script]);
  else if (operation === 'execSync') cp.execSync(`"${process.execPath}" "${script}"`);
  else if (operation === 'promisified') await promisify(cp.execFile)(process.execPath, [script]);
  else if (operation === 'execFile') await new Promise<void>((resolve, reject) => cp.execFile(process.execPath, [script], error => error ? reject(error) : resolve()));
  else await new Promise<void>((resolve, reject) => {
    const child = operation === 'fork' ? cp.fork(script) : cp.spawn(process.execPath, [script]);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual([null, null]);
});
it('rejects a prepared API environment after billing changes before the actual spawn', () => {
  saveRuntimeBillingMode('codex', 'api');
  const env = childEnvironment({ runtimeId: 'codex' });
  saveRuntimeBillingMode('codex', 'subscription');
  expect(() => cp.spawnSync(process.execPath, [script], { env })).toThrow(/changed during child preparation/);
});
it('rejects historical credential values retained in prepared arguments after a restart', async () => {
  mutateProviderKey('OPENAI_API_KEY', { key: null });
  vi.resetModules();
  const fresh = await import('@/lib/providers/child-process');
  expect(() => fresh.spawnSync(process.execPath, [script, '--header=Bearer fixture-boundary-key'])).toThrow(/arguments contain/);
});
it('preserves API mode at the actual process boundary', () => {
  saveRuntimeBillingMode('codex', 'api');
  cp.execFileSync(process.execPath, [script], { env: childEnvironment({ runtimeId: 'codex' }) });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(['fixture-boundary-key', 'fixture-boundary-key']);
});
it.each(['api', 'subscription'] as const)('preserves work admission and credential policy in %s', async mode => {
  saveRuntimeBillingMode('codex', mode);
  const { spawnWithWorkAdmission } = await import('@/lib/app-update/work-launch-admission');
  const { childEnvironment: admittedEnvironment } = await import('@/lib/providers/spawn-environment');
  const child = spawnWithWorkAdmission(process.execPath, [script], mode === 'api' ? { env: admittedEnvironment({ runtimeId: 'codex' }) } : {});
  const leases = join(state.dir, 'work-launches');
  const records = readdirSync(leases);
  expect(records).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(leases, records[0]!), 'utf8')).pid).toBe(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(mode === 'api' ? ['fixture-boundary-key', 'fixture-boundary-key'] : [null, null]);
  expect(readdirSync(leases)).toEqual([]);
});

it('the real app bridge can reread an override-encrypted store without giving its runtime the master key', async () => {
  saveRuntimeBillingMode('codex', 'api');
  const target = join(state.dir, 'fixture-codex');
  writeFileSync(target, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({key:process.env.OPENAI_API_KEY,master:process.env.O8_MASTER_KEY??null}));process.exit(0);`);
  chmodSync(target, 0o755);
  const spec = join(state.dir, 'bridge-spec.json');
  writeFileSync(spec, JSON.stringify({ codexBin: target, cwd: state.dir, threadId: null, developerInstructions: null, message: 'Fixture', imagePaths: [], model: 'fixture', effort: 'low', serviceTier: null, sandbox: 'read-only', config: {} }));
  rmSync(output, { force: true });
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'src/lib/codex/app-server-exec-bridge.ts', spec], {
      env: internalBrokerEnvironment(childEnvironment({ runtimeId: 'codex', env: { O8_DATA_DIR: state.dir } })),
    });
    let stderr = '';
    child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', () => stderr.includes('Credential store unavailable') ? reject(new Error(stderr)) : resolve());
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ key: 'fixture-boundary-key', master: null });
}, 20_000);
it.each(['api', 'subscription', 'remove'])('MCP aliases resolve at the actual server boundary in %s', async mode => {
  saveRuntimeBillingMode('codex', mode === 'subscription' ? 'subscription' : 'api');
  if (mode === 'remove') mutateProviderKey('OPENAI_API_KEY', { key: null });
  const { prepareProviderMcpLaunch } = await import('@/lib/providers/mcp-launch');
  const prepared = prepareProviderMcpLaunch({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({alias:process.env.LLM_API_KEY??null,master:process.env.O8_MASTER_KEY??null}));`], env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'fixture-boundary-key' } }, 'codex');
  expect(JSON.stringify(prepared)).not.toContain('fixture-boundary-key');
  const { guardedWorkspaceInvocation } = await import('@/lib/worktree/materialization-execution');
  const { statSync, realpathSync } = await import('node:fs');
  const stat = statSync(state.dir);
  const guarded = guardedWorkspaceInvocation(prepared.command, prepared.args, { canonicalPath: realpathSync(state.dir), device: stat.dev, inode: stat.ino } as Parameters<typeof guardedWorkspaceInvocation>[2]);
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(guarded.command, guarded.args, { cwd: state.dir, env: childEnvironment({ runtimeId: 'codex', env: prepared.env }) });
    let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ alias: mode === 'api' ? 'fixture-boundary-key' : null, master: null });
});
it.each(['subscription', 'remove'])('strips embedded provider copies from auxiliary env after %s', async mode => {
  if (mode === 'remove') mutateProviderKey('OPENAI_API_KEY', { key: null });
  vi.resetModules();
  const fresh = await import('@/lib/providers/child-process');
  const result = fresh.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.AUTHORIZATION??null,process.env.JSON_AUTH??null]))'], {
    encoding: 'utf8', env: { NODE_ENV: 'test', AUTHORIZATION: 'Bearer fixture-boundary-key', JSON_AUTH: '{"key":"prefix-fixture-boundary-key-suffix"}' },
  });
  expect(JSON.parse(result)).toEqual([null, null]);
});

it.skipIf(process.platform !== 'darwin')('MCP aliases launch through the enforced worker sandbox while the credential store stays unreadable', async () => {
  vi.stubEnv('O8_DATA_DIR', state.dir);
  saveRuntimeBillingMode('codex', 'api');
  const repo = join(state.dir, 'packet'); mkdirSync(repo, { recursive: true });
  cp.execFileSync('git', ['init', '-q', repo]);
  const record = join(repo, 'mcp-observed.json');
  const { prepareProviderMcpLaunch } = await import('@/lib/providers/mcp-launch');
  const { credentialPolicySandbox } = await import('@/lib/providers/credential-sandbox');
  const { prepareWorkerSandbox } = await import('@/lib/runtimes/shared/owned-session/sandbox');
  const prepared = prepareProviderMcpLaunch({ command: process.execPath, args: ['-e', `const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(join(state.dir, '.env.local'))});}catch{denied=true;}fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({alias:process.env.LLM_API_KEY,denied,master:process.env.O8_MASTER_KEY??null}));`], env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'fixture-boundary-key' } }, 'codex');
  const sandbox = await prepareWorkerSandbox({ runId: 'fixture-mcp', profileDir: repo, cwd: repo, repoPath: repo, binary: prepared.command, args: prepared.args, finalCredentialPolicy: credentialPolicySandbox() });
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(sandbox.binary, sandbox.args, { cwd: repo, env: childEnvironment({ runtimeId: 'codex', env: prepared.env }) });
    let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ alias: 'fixture-boundary-key', denied: true, master: null });
}, 30_000);

it('preserves policy and options with an explicitly omitted child argument array', async () => {
  saveRuntimeBillingMode('codex', 'api');
  const env = childEnvironment({ runtimeId: 'codex' });
  const sync = cp.spawnSync(process.execPath, undefined, { env, input: 'process.stdout.write(process.env.OPENAI_API_KEY)', encoding: 'utf8' });
  expect(sync.stdout).toBe('fixture-boundary-key');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = cp.execFile(process.execPath, undefined, { env }, (error, result) => error ? reject(error) : resolve(result));
    child.stdin!.end('process.stdout.write(process.env.OPENAI_API_KEY)');
  });
  expect(stdout).toBe('fixture-boundary-key');
});
