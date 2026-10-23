import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { listDeclarativeRuntimes } from '@/lib/orchestrator/runtime-capabilities';

const state = vi.hoisted(() => ({ dir: '', runtime: '', envs: [] as NodeJS.ProcessEnv[], children: [] as EventEmitter[], args: [] as string[][], bridges: 0, mcp: false }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/cli-resolver')>(), resolveCli: vi.fn(async () => ({ path: process.execPath })) }));
vi.mock('@/lib/runtimes/shared/cli-locate', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/cli-locate')>(), resolveClaudeBinary: () => process.execPath }));
vi.mock('@/lib/runtimes/shared/owned-session/workspace-spawn-guard', async original => ({ ...await original<typeof import('@/lib/runtimes/shared/owned-session/workspace-spawn-guard')>(), assertOwnedWorkspaceSpawnAvailable: vi.fn(async () => ({ status: 'available' })) }));
vi.mock('@/lib/hermes/runtime-resolution', () => ({ resolveHermesBinary: () => process.execPath }));
vi.mock('@/lib/deepseek-harness/runtime-resolution', () => ({ resolveDeepSeekHarnessLaunch: async () => ({ command: process.execPath, args: [] }) }));
vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({ prepareClaudeCodeWorkerConfig: async () => ({ configDir: join(state.dir, 'claude-config'), credentialEnv: {} }) }));
vi.mock('@/lib/mcp/worker-injection', async original => ({ ...await original<typeof import('@/lib/mcp/worker-injection')>(), resolveWorkerMcpInjection: async () => ({ servers: state.mcp ? [{ id: 'fixture', name: 'fixture', command: process.execPath, args: [], env: { OPENAI_API_KEY: 'fixture-stale-mcp', LLM_API_KEY: 'fixture-stale-mcp', MCP_SERVICE_TOKEN: 'fixture-non-provider' } }] : [], skipped: [] }) }));
vi.mock('@/lib/pi/managed-usage', () => ({ createPiManagedUsageTransport: () => ({ stream: async function* () {} }) }));
vi.mock('@/lib/pi/sdk/scripts', () => ({ piSdkScriptPath: () => 'fixture-worker.mjs' }));
vi.mock('@/lib/pi/sdk/platform', () => ({ requirePiNode: () => {}, requirePiPlatform: () => {} }));
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: async (payload: { env: Record<string, string>; resolvedEnvironment?: boolean; shellCommand: string }) => {
  state.bridges += 1;
  expect(payload.resolvedEnvironment).toBe(true);
  const { managedCommandLaunch } = await import('@/lib/terminal/managed-command-launch');
  const launch = managedCommandLaunch('/fixture/login-shell', payload.shellCommand, { ...process.env, GOOGLE_API_KEY: 'fixture-daemon-stale' }, payload.env, payload.resolvedEnvironment);
  state.envs.push(launch.env); return { ok: true, sessionName: `fixture-${state.runtime}`, pid: 999999999 };
} }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
  state.envs.push(options.env); state.args.push(_args);
  const child = Object.assign(new EventEmitter(), { pid: 999999999, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null as Writable | null, unref() {}, kill() { return true; } });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split('\n')) {
      try {
        const frame = JSON.parse(line);
        if (frame.id && frame.method) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id,
          result: frame.method === 'initialize' ? { protocolVersion: 1, agentInfo: { name: state.runtime === 'deepseek-harness' ? 'deepseek-harness-acp' : state.runtime, version: 'fixture' }, sessionId: 'fixture', sessionFile: join(state.dir, 'session.jsonl'), tools: [] }
            : frame.method === 'session/new' ? { sessionId: 'fixture' } : frame.method === 'prompt' ? { assistantText: '', modelCalls: 0, toolCalls: 0 } : { stopReason: 'end_turn' } })}\n`));
      } catch { /* Generic CLIs may use non-JSON stdin. */ }
    }
    done();
  } });
  state.children.push(child); return child;
} }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-launch-keys-'));
const repo = join(state.dir, 'repo'); mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
const { clearMasterKeyCache } = await import('@/lib/db/master-key');
const routes = await import('./route');
const request = (method: string, provider: string, extra: object = {}) => new NextRequest('http://localhost/api/v2/keys', { method, headers: { host: 'localhost' }, body: JSON.stringify({ provider, ...extra }) });
const providers = ['openrouter', 'openai', 'anthropic', 'deepseek', 'gemini', 'groq', 'elevenlabs', 'google_tts'];
const keys = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY'];
const aliases = ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const generic = ['codex', 'claude-code', 'gemini', 'cursor', 'prime-agent', 'muse', 'opencode'];
const acp = ['hermes', 'grok', 'deepseek-harness'];
const declarative = listDeclarativeRuntimes();
const modules: Record<string, { launch: (request: never) => Promise<unknown> }> = {};
beforeAll(async () => {
  const loaders = [
    ['codex', 'Codex', () => import('@/lib/codex/owned')],
    ['claude-code', 'ClaudeCode', () => import('@/lib/claude-code/owned')],
    ['gemini', 'Gemini', () => import('@/lib/gemini/owned')],
    ['cursor', 'Cursor', () => import('@/lib/cursor/owned')],
    ['prime-agent', 'PrimeAgent', () => import('@/lib/prime-agent/owned')],
    ['muse', 'Muse', () => import('@/lib/muse/owned')],
    ['opencode', 'Opencode', () => import('@/lib/opencode/owned')],
    ['hermes', 'Hermes', () => import('@/lib/hermes/owned')],
    ['grok', 'Grok', () => import('@/lib/grok/owned')],
    ['deepseek-harness', 'DeepSeekHarness', () => import('@/lib/deepseek-harness/owned')],
    ['pi', 'Pi', () => import('@/lib/pi/owned')],
    ['pi-builtin', 'PiBuiltin', () => import('@/lib/pi-builtin/owned')],
  ] as const;
  for (const [runtime, suffix, load] of loaders) {
    const runtimeModule = await load() as unknown as Record<string, ((request: never) => Promise<unknown>) | { launch: (request: never) => Promise<unknown> }>;
    modules[runtime] = { launch: runtime === 'muse' ? (runtimeModule.museOwnedStore as { launch: (request: never) => Promise<unknown> }).launch : runtimeModule[`launchOwned${suffix}Session`] as (request: never) => Promise<unknown> };
  }
  await import('@/lib/runtimes/declarative-workers');
  const { getDeclarativeOwnedRuntime } = await import('@/lib/runtimes/shared/owned-session');
  for (const runtime of declarative) modules[runtime] = { launch: getDeclarativeOwnedRuntime(runtime)!.store.launch };

});
beforeEach(() => {
  state.envs.length = 0; state.args.length = 0; state.bridges = 0; state.mcp = false;
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 61).toString('base64url')); clearMasterKeyCache();
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1'); vi.stubEnv('O8_WORKER_SANDBOX', '0');
  for (const name of [...keys, ...aliases]) vi.stubEnv(name, `fixture-ambient-${name}`);
  vi.stubEnv('XAI_API_KEY', 'fixture-unmanaged-xai'); vi.stubEnv('NOUS_API_KEY', 'fixture-unmanaged-nous');
  const hermes = join(state.dir, 'operator-hermes'); mkdirSync(hermes, { recursive: true });
  writeFileSync(join(hermes, 'config.yaml'), 'model:\n  provider: openai\n  api_key: fixture-stale-profile\n');
  writeFileSync(join(hermes, '.env'), 'OPENAI_API_KEY=fixture-stale-profile\nLLM_API_KEY=fixture-stale-profile\n');
  vi.stubEnv('HERMES_HOME', hermes);
  writeFileSync(join(state.dir, '.env.local'), '');
  rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterEach(async () => { for (const child of state.children.splice(0)) child.emit('close', 0, null); await new Promise(resolve => setTimeout(resolve, 20)); });
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearMasterKeyCache(); rmSync(state.dir, { recursive: true, force: true }); });
const cases = [...[...generic, ...declarative].flatMap(runtime => ['direct', 'bridge'].map(mode => [runtime, mode])), ...acp.map(runtime => [runtime, 'acp']), ['pi', 'rpc'], ['pi-builtin', 'sdk']];
it.each(cases.flatMap(([runtime, mode]) => ['enabled', 'disable', 'remove'].map(action => [runtime, mode, action])))('%s %s launch obeys real API %s for all provider families', async (runtime, mode, action) => {
  state.runtime = runtime;
  const billing = await import('@/app/api/runtime/billing/route');
  expect((await billing.POST(new NextRequest('http://localhost/api/runtime/billing', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ runtimeId: runtime, mode: 'api' }) }))).status).toBe(200);
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', mode === 'bridge' ? '0' : '1');
  for (const provider of providers) {
    expect((await routes.POST(request('POST', provider, { key: `fixture-saved-${provider}` }))).status).toBe(200);
    if (action !== 'enabled') expect((await (action === 'disable' ? routes.PATCH(request('PATCH', provider, { enabled: false })) : routes.DELETE(request('DELETE', provider)))).status).toBe(200);
  }
  const result = await modules[runtime].launch({ cwd: repo, prompt: 'fixture', runtimeConfig: { museConfigRoot: join(state.dir, 'muse-config'), museDataRoot: join(state.dir, 'muse-data') } } as never);
  expect(result).toMatchObject({ ok: true });
  expect(state.envs.length).toBeGreaterThan(0);
  for (const env of state.envs) {
    if (runtime === 'hermes' && action !== 'enabled') {
      expect(readFileSync(join(env.HERMES_HOME!, '.env'), 'utf8')).not.toContain('fixture-stale-profile');
      expect(readFileSync(join(env.HERMES_HOME!, 'config.yaml'), 'utf8')).not.toContain('fixture-stale-profile');
    }
    for (const [index, key] of keys.entries()) {
      const enabled = action === 'enabled' && mode !== 'sdk' && !(runtime === 'muse' && key === 'OPENROUTER_API_KEY');
      expect(env[key] || null, `${runtime} ${mode} ${key}`).toBe(enabled ? `fixture-saved-${providers[index]}` : null);
    }
    for (const key of aliases) {
      const provider = key === 'CODEX_API_KEY' ? 'openai' : key === 'ANTHROPIC_AUTH_TOKEN' ? 'anthropic' : 'gemini';
      expect(env[key] || null, `${runtime} ${mode} ${key}`).toBe(action === 'enabled' && mode !== 'sdk' ? `fixture-saved-${provider}` : null);
    }
    if (mode !== 'sdk') { expect(env.XAI_API_KEY).toBe('fixture-unmanaged-xai'); expect(env.NOUS_API_KEY).toBe('fixture-unmanaged-nous'); }
  }
});

it('Windows owned launch uses direct spawn when the POSIX bridge is enabled', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(await modules['prime-agent'].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
    expect(state.envs.length).toBeGreaterThan(0); expect(state.bridges).toBe(0);
  } finally { Object.defineProperty(process, 'platform', platform); }
});
it('ACP launch retains an explicit unmanaged provider override instead of an ambient key', async () => {
  const { AcpClient } = await import('@/lib/acp/client');
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('hermes', 'api');
  const client = new AcpClient({ runtimeId: 'hermes', command: process.execPath, args: [], env: { XAI_API_KEY: 'fixture-explicit-xai' } });
  expect(state.envs.at(-1)?.XAI_API_KEY).toBe('fixture-explicit-xai');
  client.kill();
});

it.each(['codex', 'claude-code'])('%s subscription default never changes payer through saved keys', async runtime => {
  state.runtime = runtime;
  for (const provider of ['openai', 'anthropic']) expect((await routes.POST(request('POST', provider, { key: `fixture-saved-${provider}` }))).status).toBe(200);
  expect(await modules[runtime].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.length).toBeGreaterThan(0);
  for (const env of state.envs) for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) expect(env[name] || null, name).toBeNull();
});
it.each(['disable', 'remove'])('generic aliases obey real API %s in owned spawn', async action => {
  state.runtime = 'goose';
  const billing = await import('@/app/api/runtime/billing/route');
  expect((await billing.POST(new NextRequest('http://localhost/api/runtime/billing', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ runtimeId: 'goose', mode: 'api' }) }))).status).toBe(200);
  for (const name of ['LLM_PROVIDER', 'GOOSE_PROVIDER', 'COPILOT_PROVIDER_TYPE']) vi.stubEnv(name, 'openai');
  for (const alias of ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN']) vi.stubEnv(alias, 'fixture-stale-alias');
  expect((await routes.POST(request('POST', 'openai', { key: 'fixture-openai' }))).status).toBe(200);
  expect((await (action === 'disable' ? routes.PATCH(request('PATCH', 'openai', { enabled: false })) : routes.DELETE(request('DELETE', 'openai')))).status).toBe(200);
  expect(await modules.goose.launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  for (const env of state.envs) for (const name of ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN']) expect(env[name] || null, name).toBeNull();
});

it.each(['codex', 'claude-code'])('%s saved API billing permits saved credentials and survives a fresh read', async runtime => {
  state.runtime = runtime;
  const billing = await import('@/app/api/runtime/billing/route');
  const url = 'http://localhost/api/runtime/billing';
  expect((await billing.POST(new NextRequest(url, { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ runtimeId: runtime, mode: 'api' }) }))).status).toBe(200);
  expect(await (await billing.GET(new NextRequest(`${url}?runtimeId=${runtime}`, { headers: { host: 'localhost' } }))).json()).toMatchObject({ mode: 'api' });
  expect((await routes.POST(request('POST', runtime === 'codex' ? 'openai' : 'anthropic', { key: 'fixture-billed-api' }))).status).toBe(200);
  expect(await modules[runtime].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.[runtime === 'codex' ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY']).toBe('fixture-billed-api');
});

it.each(['disable', 'remove'])('MCP child receives no revoked key after real API %s', async action => {
  expect((await routes.POST(request('POST', 'openai', { key: 'fixture-saved-openai' }))).status).toBe(200);
  expect((await (action === 'disable' ? routes.PATCH(request('PATCH', 'openai', { enabled: false })) : routes.DELETE(request('DELETE', 'openai')))).status).toBe(200);
  const { testMcpConnection } = await import('@/lib/mcp/test-connection');
  expect(await testMcpConnection({ transport: 'stdio', command: process.execPath, env: { OPENAI_API_KEY: 'fixture-stale-mcp', LLM_API_KEY: 'fixture-stale-mcp', MCP_SERVICE_TOKEN: 'fixture-non-provider' } }, 1_000)).toMatchObject({ ok: true });
  const env = state.envs.at(-1)!;
  expect(env.OPENAI_API_KEY || null).toBeNull(); expect(env.LLM_API_KEY || null).toBeNull(); expect(env.MCP_SERVICE_TOKEN).toBe('fixture-non-provider');
});
it.each(['codex', 'claude-code'])('%s launch filters revoked credentials before MCP config serialization', async runtime => {
  state.runtime = runtime; state.mcp = true;
  const billing = await import('@/app/api/runtime/billing/route');
  expect((await billing.POST(new NextRequest('http://localhost/api/runtime/billing', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ runtimeId: runtime, mode: 'api' }) }))).status).toBe(200);
  expect((await routes.POST(request('POST', 'openai', { key: 'fixture-saved-openai' }))).status).toBe(200);
  expect((await routes.DELETE(request('DELETE', 'openai'))).status).toBe(200);
  expect(await modules[runtime].launch({ cwd: repo, prompt: 'fixture', packetId: 'fixture-mcp-packet' } as never)).toMatchObject({ ok: true });
  const args = state.args.at(-1)!;
  if (runtime === 'claude-code') {
    const raw = readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8');
    expect(raw).not.toContain('fixture-stale-mcp'); expect(raw).toContain('fixture-non-provider');
  } else {
    expect(args.join(' ')).not.toContain('fixture-stale-mcp'); expect(args.join(' ')).toContain('fixture-non-provider');
  }
});

it('Copilot aliases use its provider selector when the generic LLM selector differs', async () => {
  state.runtime = 'copilot-cli';
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('copilot-cli', 'api');
  vi.stubEnv('COPILOT_PROVIDER_TYPE', 'gemini'); vi.stubEnv('LLM_PROVIDER', 'openai');
  vi.stubEnv('COPILOT_PROVIDER_API_KEY', 'fixture-stale-copilot'); vi.stubEnv('COPILOT_PROVIDER_BEARER_TOKEN', 'fixture-stale-copilot');
  for (const provider of ['openai', 'gemini']) expect((await routes.POST(request('POST', provider, { key: `fixture-${provider}` }))).status).toBe(200);
  expect(await modules['copilot-cli'].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.COPILOT_PROVIDER_API_KEY).toBe('fixture-gemini'); expect(state.envs.at(-1)?.COPILOT_PROVIDER_BEARER_TOKEN).toBe('fixture-gemini');
  expect((await routes.DELETE(request('DELETE', 'gemini'))).status).toBe(200);
  expect(await modules['copilot-cli'].launch({ cwd: repo, prompt: 'fixture' } as never)).toMatchObject({ ok: true });
  expect(state.envs.at(-1)?.COPILOT_PROVIDER_API_KEY || null).toBeNull(); expect(state.envs.at(-1)?.COPILOT_PROVIDER_BEARER_TOKEN || null).toBeNull();
});
it.each(['disable', 'remove'])('Fable resident launch cannot restore its scoped Anthropic alias after API %s', async action => {
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('claude-code', 'api');
  vi.stubEnv('O8_FABLE_ANTHROPIC_API_KEY', 'fixture-stale-fable');
  expect((await routes.POST(request('POST', 'anthropic', { key: 'fixture-saved-anthropic' }))).status).toBe(200);
  expect((await (action === 'disable' ? routes.PATCH(request('PATCH', 'anthropic', { enabled: false })) : routes.DELETE(request('DELETE', 'anthropic')))).status).toBe(200);
  const { spawnOrchestratorProc, getWarmState } = await import('@/lib/lane/orchestrator-resident-process');
  const session = { sessionName: 'fixture-fable', repoPath: repo, threadId: null, claudeSessionId: null, status: 'ready', proc: null, createdAt: Date.now() };
  spawnOrchestratorProc(session as never, getWarmState(session.sessionName), { cwd: repo, model: 'claude-opus-4-8', permissionMode: 'full', toolProfile: 'fable', effort: 'high', mcpConfigPath: join(state.dir, 'mcp.json'), modelSource: 'native' } as never, {}, 'fixture');
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'O8_FABLE_ANTHROPIC_API_KEY']) expect(state.envs.at(-1)?.[name] || null, name).toBeNull();
});
