import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
const state = vi.hoisted(() => ({ dir: '', injectMcp: true, ready: async () => {}, args: [] as string[], spawns: [] as { args: string[]; env: Record<string, string | undefined>; bridge: boolean }[], children: [] as EventEmitter[] }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: () => state.ready() }));
vi.mock('@/lib/runtimes/shared/cli-resolver', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/cli-resolver')>(), resolveCli: async () => ({ path: process.execPath }) }));
vi.mock('@/lib/runtimes/shared/owned-session/workspace-spawn-guard', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/owned-session/workspace-spawn-guard')>(), assertOwnedWorkspaceSpawnAvailable: async () => ({ status: 'available' }) }));
vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({ prepareClaudeCodeWorkerConfig: async () => ({ configDir: join(state.dir, 'claude-config'), credentialEnv: {} }) }));
vi.mock('@/lib/mcp/worker-injection', async original => ({ ...await original<typeof import('@/lib/mcp/worker-injection')>(), resolveWorkerMcpInjection: async () => ({ servers: state.injectMcp ? [{ id: 'fixture', name: 'fixture', command: process.execPath, args: [], env: { GEMINI_API_KEY: 'fixture-source-key', LLM_PROVIDER: 'gemini', LLM_API_KEY: 'fixture-source-key', MCP_SERVICE_TOKEN: 'fixture-service' } }] : [], skipped: [] }) }));
vi.mock('@/lib/runtimes/shared/execution-carrier-launch', async original => {
  const real = await original<typeof import('@/lib/runtimes/shared/execution-carrier-launch')>();
  return { ...real, resolveExecutionCarrierInvocation: async (input: Parameters<typeof real.resolveExecutionCarrierInvocation>[0]) => { const value = await real.resolveExecutionCarrierInvocation(input); state.args = value.args; return value; } };
});
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: async (payload: { shellCommand: string; env: NodeJS.ProcessEnv }) => { state.spawns.push({ args: [payload.shellCommand], env: { GEMINI_API_KEY: payload.env.GEMINI_API_KEY }, bridge: true }); return { ok: true, sessionName: 'fixture-mcp', pid: 999999999 }; } }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
  state.spawns.push({ args, env: { GEMINI_API_KEY: options.env.GEMINI_API_KEY }, bridge: false });
  const child = Object.assign(new EventEmitter(), { pid: 999999999, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }), unref() {}, kill() {} });
  state.children.push(child); return child;
} }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-mcp-launch-revocation-'));
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(state.dir, 'owned-codex'));
vi.stubEnv('CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT', join(state.dir, 'owned-claude-code'));
const repo = join(state.dir, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const codex = await import('@/lib/codex/owned'); const claude = await import('@/lib/claude-code/owned');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
const secret = 'fixture-mcp-snapshot-key';
function copies(dir = state.dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? copies(join(dir, entry.name)) : entry.isFile() && /^(?:o8-worker-mcp-.*|[a-z0-9-]+\.mcp)\.json$/.test(entry.name) ? [join(dir, entry.name)] : []);
}
const launch = (runtime: string) => (runtime === 'codex' ? codex.launchOwnedCodexSession : claude.launchOwnedClaudeCodeSession)({ cwd: repo, prompt: 'fixture', packetId: 'fixture-mcp-packet' }).catch(error => ({ ok: false, note: String(error) }));
async function authorize(runtime: string) {
  expect((await billing.POST(request('runtime/billing', { runtimeId: runtime, mode: 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'gemini', key: secret }))).status).toBe(200);
}
beforeEach(() => {
  state.injectMcp = true; state.spawns.length = 0; state.args = []; state.ready = async () => {};
  writeFileSync(join(state.dir, '.env.local'), '');
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 83).toString('base64url'));
  vi.stubEnv('GEMINI_API_KEY', ''); vi.stubEnv('O8_WORKER_SANDBOX', '0'); vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterEach(async () => { for (const child of state.children.splice(0)) child.emit('close', 0, null); await new Promise(resolve => setTimeout(resolve, 25)); });
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
const races = ['codex', 'claude-code'].flatMap(runtime => ['direct', 'bridge'].flatMap(mode => ['disable', 'remove', 'subscription'].map(action => [runtime, mode, action])));
it.each(races)('%s requested %s rejects stale MCP credentials after %s during readiness', async (runtime, mode, action) => {
  await authorize(runtime); vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', mode === 'bridge' ? '0' : '1');
  let prepared!: () => void; let resume!: () => void;
  const preparation = new Promise<void>(resolve => { prepared = resolve; }); const gate = new Promise<void>(resolve => { resume = resolve; });
  state.ready = async () => { prepared(); await gate; };
  const pending = launch(runtime);
  await Promise.race([preparation, pending.then(result => { throw new Error(`Launch stopped before readiness: ${JSON.stringify(result)}`); })]);
  const containedKey = runtime === 'codex' ? state.args.join(' ').includes(secret) : copies().some(file => readFileSync(file, 'utf8').includes(secret));
  try {
    const response = action === 'subscription' ? await billing.POST(request('runtime/billing', { runtimeId: runtime, mode: 'subscription' }))
      : action === 'disable' ? await keys.PATCH(request('v2/keys', { provider: 'gemini', enabled: false }, 'PATCH')) : await keys.DELETE(request('v2/keys', { provider: 'gemini' }, 'DELETE'));
    expect(response.status).toBe(200);
  } finally { resume(); }
  const remaining = copies().some(file => readFileSync(file, 'utf8').includes(secret));
  const result = await pending;
  expect(containedKey).toBe(false); expect(remaining).toBe(false); expect(state.spawns).toHaveLength(0); expect(result.ok).toBe(false);
}, 30_000);
it.each(['codex', 'claude-code'])('%s permits current API-mode MCP configuration on the guarded direct spawn', async runtime => {
  await authorize(runtime); vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
  expect((await launch(runtime)).ok).toBe(true);
  expect(state.spawns.length).toBeGreaterThan(0); expect(state.spawns.every(spawn => !spawn.bridge)).toBe(true);
  expect(state.spawns.at(-1)?.env.GEMINI_API_KEY).toBe(secret);
});
it('a real API mutation after module restart scrubs previously generated owned MCP files', async () => {
  await authorize('claude-code'); expect((await launch('claude-code')).ok).toBe(true);
  const paths = copies(); expect(paths.length).toBeGreaterThan(0); expect(paths.some(file => readFileSync(file, 'utf8').includes(secret))).toBe(false);
  // A legacy writer can still leave plaintext; restarted mutation must purge it.
  writeFileSync(paths[0], JSON.stringify({ mcpServers: { fixture: { env: { GEMINI_API_KEY: secret } } } }));
  vi.resetModules(); const restarted = await import('@/app/api/v2/keys/route');
  expect((await restarted.DELETE(request('v2/keys', { provider: 'gemini' }, 'DELETE'))).status).toBe(200);
  expect(copies().some(file => readFileSync(file, 'utf8').includes(secret))).toBe(false);
});
it('billing changes share the credential mutation lock and retain the previous mode when busy', async () => {
  await authorize('claude-code');
  const lock = new Database(join(state.dir, '.provider-keys.lock')); lock.exec('BEGIN EXCLUSIVE');
  try { expect((await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode: 'subscription' }))).status).toBe(503); }
  finally { lock.close(); }
  expect(JSON.parse(readFileSync(join(state.dir, 'runtime-billing', 'claude-code.json'), 'utf8')).mode).toBe('api');
});

it.each(['codex', 'claude-code'])('%s keeps credential-bearing launches synchronous even without MCP snapshots', async runtime => {
  await authorize(runtime); state.injectMcp = false; vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
  expect((await launch(runtime)).ok).toBe(true);
  expect(state.spawns.length).toBeGreaterThan(0);
  expect(state.spawns.every(spawn => !spawn.bridge)).toBe(true);
  expect(state.spawns.at(-1)?.env.GEMINI_API_KEY).toBe(secret);
});
