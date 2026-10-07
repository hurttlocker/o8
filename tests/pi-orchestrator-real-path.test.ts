import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { buildToolRegistry, resetToolSpinePortIdentityForTests } from '@/lib/mcp/tool-spine/build';
import { toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';
import { entriesForSurface } from '@/lib/mcp/tool-spine/registry';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';
import { createPiOrchestratorBackend, PI_ORCHESTRATOR_LIMITS } from '@/lib/lane/orchestrator-backends/pi';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createO8CommandTools, listO8Commands } from '@/lib/pi/orchestrator/o8-commands';
import { openO8Servers } from '@/lib/pi/orchestrator/o8-servers';
import { PI_ALLOWANCE_EXHAUSTED_MESSAGE } from '@/lib/pi/sdk/transport';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

// The real app routes behind a local HTTP server and the real middleware gate:
// /api/mcp, so the operator stdio proxy (Claude's path) and Pi's HTTP client
// both reach the in-app host, and /api/panel/repos, which o8_list_repos calls.
let api: Server;
const saved = { NEXT_ORIGIN: process.env.NEXT_ORIGIN, O8_API_PORT: process.env.O8_API_PORT };
beforeAll(async () => {
  buildPiWriteHelper();
  getOrCreateWsToken();
  const { panelGateMiddleware } = await import('@/middleware');
  const routes: Record<string, Record<string, (request: Request) => Promise<Response>>> = {
    '/api/mcp': await import('@/app/api/mcp/route') as never,
    '/api/panel/repos': await import('@/app/api/panel/repos/route') as never,
  };
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handler = routes[url.pathname]?.[req.method ?? 'GET'];
    if (!handler) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
    const gate = panelGateMiddleware(new NextRequest(url, { method: req.method, headers, body }));
    const response = gate.headers.get('x-middleware-next') === '1'
      ? await handler(new Request(url, { method: req.method, headers, body }))
      : gate;
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text());
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const { port } = api.address() as AddressInfo;
  process.env.NEXT_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.O8_API_PORT = String(port);
  await writeFile(join(getDataDir(), 'api-port'), String(port));
  resetToolSpinePortIdentityForTests();
}, 600_000);
afterAll(async () => {
  await new Promise(resolve => api.close(resolve));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetToolSpinePortIdentityForTests();
});

const roots: string[] = [];
const backends: Array<ReturnType<typeof createPiOrchestratorBackend>> = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map(backend => backend.closeAll()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-orch-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await import('node:fs/promises').then(fs => fs.mkdir(repo));
  return { repo, stateRoot: join(root, 'state') };
}

/** Lists a stdio MCP server's tools exactly as an MCP client would. */
async function listTools(config: { command: string; args?: string[]; env?: Record<string, string> }, cwd: string) {
  const peer = new StdioJsonRpcPeer({ command: config.command, args: config.args ?? [], cwd,
    env: { ...process.env, ...config.env } }, 120_000);
  try {
    await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'parity', version: '1' } });
    const result = await peer.request<{ tools: Array<{ name: string; inputSchema: unknown }> }>('tools/list', {});
    return result.tools;
  } finally { await peer.close({ gracefulMs: 200 }); }
}

const model = { id: 'google/gemini-2.5-flash-lite', api: 'openai-completions' as const, provider: 'o8-managed' };
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: model.id, api: model.api, provider: model.provider,
    timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function events(answer: AssistantMessage): AssistantMessageEvent[] {
  if (answer.stopReason === 'error') return [{ type: 'error', reason: 'error', error: answer }];
  return [{ type: 'start', partial: answer },
    ...(answer.content[0]?.type === 'text' ? [{ type: 'text_delta' as const, contentIndex: 0, delta: answer.content[0].text, partial: answer }] : []),
    { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }];
}
function call(id: string, name: string, args: Record<string, string>): AssistantMessage {
  return message([{ type: 'toolCall', id, name, arguments: args }], 'toolUse');
}
type SystemMessage = { role?: string; sections?: { preamble?: string }; toolsAdded?: Array<{ name: string }> };
/** A scripted model: each call answers with the next message and records the context it saw. */
function script(answers: AssistantMessage[], seen: Array<{ messages: unknown[]; tools: string[]; system?: string }> = []) {
  return async function* (context: { messages: unknown[] }) {
    // Pi's normalized context carries the prompt and tool declarations in its system messages.
    const system = (context.messages as SystemMessage[]).filter(entry => entry.role === 'system');
    seen.push({ messages: context.messages, tools: system.flatMap(entry => (entry.toolsAdded ?? []).map(tool => tool.name)),
      system: system.map(entry => entry.sections?.preamble ?? '').join('\n') });
    const answer = answers.shift();
    if (!answer) throw new Error('No scripted answer left');
    yield* events(answer);
  };
}
async function turn(backend: ReturnType<typeof createPiOrchestratorBackend>, repo: string, text: string,
  options: { threadId?: string; signal?: AbortSignal } = {}) {
  const out: OrchestratorEvent[] = [];
  await backend.sendTurn(repo, text, event => out.push(event), { threadId: options.threadId ?? 'thoughts-pi-test', signal: options.signal });
  return out;
}

describe('Pi orchestrator (#3258)', () => {
  it('reaches exactly the o8 commands the Claude orchestrator gets from its built-in servers', async () => {
    const { repo } = await fixture();
    const registry = buildToolRegistry(repo, { profile: 'full', threadId: 'thoughts-pi-test' });
    const builtIn = entriesForSurface(registry, 'claude-orchestrator').filter(({ entry }) => entry.source === 'builtin');
    expect(builtIn.map(({ name }) => name).sort()).toEqual(['cortex', 'operator']);
    // Claude's emitted --mcp-config, spawned as Claude would spawn it.
    const claudeServers = toClaudeJson(registry).mcpServers;
    // Claude sees each tool under its server, so parity is per server and per schema.
    const expected = new Map<string, string>();
    for (const { name } of builtIn) {
      const config = claudeServers[name];
      if (config.type !== 'stdio') throw new Error(`${name} is not a stdio server`);
      for (const tool of await listTools(config, repo)) expected.set(`${name}/${tool.name}`, JSON.stringify(tool.inputSchema));
    }
    for (const command of ['operator/create_mission', 'operator/dispatch_mission', 'operator/get_mission_status',
      'operator/o8_packet_diff', 'operator/submit_review', 'operator/o8_merge_preview', 'operator/approve_and_merge',
      'operator/o8_verify', 'operator/cortex_ask', 'cortex/cortex_ask', 'cortex/cortex_read_packets', 'cortex/cortex_fleet_status']) {
      expect(expected.has(command)).toBe(true);
    }
    // Pi's production path: operator over /api/mcp, cortex from the same tool-spine entry.
    const servers = await openO8Servers(repo, { profile: 'full', threadId: 'thoughts-pi-test' });
    try {
      const reachable = await listO8Commands(servers.servers, new AbortController().signal);
      expect(new Map(reachable.map(({ server, tool }) => [`${server.name}/${tool.name}`, JSON.stringify(tool.inputSchema)]))).toEqual(expected);
      const runNames = reachable.map(({ name }) => name);
      expect(new Set(runNames).size).toBe(runNames.length);
      expect(reachable.find(({ name }) => name === 'cortex.cortex_ask')?.server.name).toBe('cortex');
    } finally { await servers.close(); }
  }, 180_000);

  it('drops the operator server on a proposer turn, as the Claude orchestrator does', async () => {
    const { repo } = await fixture();
    const servers = await openO8Servers(repo, { profile: 'propose', threadId: 'thoughts-pi-test' });
    try {
      const names = (await listO8Commands(servers.servers, new AbortController().signal)).map(({ name }) => name);
      expect(servers.servers.map(server => server.name)).toEqual(['cortex']);
      expect(names).toContain('cortex_read_packets');
      for (const mutator of ['dispatch_mission', 'approve_and_merge', 'create_mission', 'cortex_launch_agent']) {
        expect(names).not.toContain(mutator);
      }
    } finally { await servers.close(); }
  }, 180_000);

  it('runs o8 commands through the operator server, keeps approval on repo writes, and resumes after a restart', async () => {
    const { repo, stateRoot } = await fixture();
    const seen: Array<{ messages: unknown[]; tools: string[]; system?: string }> = [];
    const approvals: string[] = [];
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      approve: async (request) => { approvals.push(`${request.name}:${String(request.args.path ?? request.args.command)}`); return true; },
      transport: script([
        call('c1', 'o8_command_help', { name: 'o8_list_repos' }),
        call('c2', 'o8_run', { name: 'o8_list_repos', arguments: '{}' }),
        call('c3', 'o8_run', { name: 'not_a_command', arguments: '{}' }),
        call('c4', 'write_file', { path: 'plan.md', content: 'ship it' }),
        message([{ type: 'text', text: 'Listed repos and wrote the plan.' }]),
      ], seen) });
    backends.push(backend);
    const out = await turn(backend, repo, 'List the repos, then write plan.md');
    expect(out[0]).toMatchObject({ type: 'turn_receipt', leadModel: 'pi' });
    expect(out.at(-1)).toMatchObject({ type: 'done' });
    expect(out.filter(event => event.type === 'error')).toEqual([]);
    expect(seen[0].tools).toEqual(['read_file', 'write_file', 'run_command', 'o8_commands', 'o8_command_help', 'o8_run']);
    expect(seen[0].system).toContain('## o8 commands in this session');
    expect(seen[0].system).toContain('dispatch_mission');
    const results = out.filter((event): event is Extract<OrchestratorEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(results.map(result => result.name)).toEqual(['o8_command_help', 'o8_run', 'o8_run', 'write_file']);
    expect(results[0].output).toContain('"name": "o8_list_repos"');
    expect(JSON.parse(results[1].output)).toMatchObject({ count: expect.any(Number), repos: expect.any(Array) });
    expect(results[2].output).toContain('Unknown o8 command: not_a_command');
    expect(results[3].output).toBe('Wrote plan.md');
    expect(approvals).toEqual(['write_file:plan.md']);
    expect(await readFile(join(repo, 'plan.md'), 'utf8')).toBe('ship it');
    expect(out.filter(event => event.type === 'text').map(event => (event as { text: string }).text).join('')).toBe('Listed repos and wrote the plan.');
    // No raw Pi message objects reach the orchestrator stream.
    expect(JSON.stringify(out)).not.toContain('"partial"');

    // A new backend (as after an app restart) resumes the same Pi session file.
    await backend.closeAll();
    const resumedSeen: Array<{ messages: unknown[]; tools: string[] }> = [];
    const resumed = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      transport: script([message([{ type: 'text', text: 'Still here.' }])], resumedSeen) });
    backends.push(resumed);
    const next = await turn(resumed, repo, 'Are you still there?');
    expect(next.filter(event => event.type === 'error')).toEqual([]);
    expect(resumedSeen[0].messages.length).toBeGreaterThan(seen[0].messages.length + 8);
    const doneIds = [out.at(-1), next.at(-1)].map(event => (event as { sessionId: string | null }).sessionId);
    expect(doneIds[0]).toBeTruthy();
    expect(doneIds[1]).toBe(doneIds[0]);
  }, 180_000);

  it('ends the turn with the allowance message when the daily allowance is used up', async () => {
    const { repo, stateRoot } = await fixture();
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      transport: script([message([], 'error', PI_ALLOWANCE_EXHAUSTED_MESSAGE)]) });
    backends.push(backend);
    const out = await turn(backend, repo, 'Plan the next mission');
    expect(out.filter(event => event.type === 'error')).toEqual([{ type: 'error', error: PI_ALLOWANCE_EXHAUSTED_MESSAGE }]);
    expect(out.at(-1)).toMatchObject({ type: 'done' });
  }, 180_000);

  it('stops on Stop without an error and takes the next message', async () => {
    const { repo, stateRoot } = await fixture();
    let calls = 0;
    const stop = new AbortController();
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      transport: async function* (_context, signal) {
        if (++calls === 1) {
          setTimeout(() => stop.abort(), 50);
          await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
        }
        yield* events(message([{ type: 'text', text: 'Next answer.' }]));
      } });
    backends.push(backend);
    const stopped = await turn(backend, repo, 'Start something long', { signal: stop.signal });
    expect(stopped.filter(event => event.type === 'error')).toEqual([]);
    expect(stopped.at(-1)).toMatchObject({ type: 'done' });
    const next = await turn(backend, repo, 'Next');
    expect(next.filter(event => event.type === 'error')).toEqual([]);
    expect(next.some(event => event.type === 'text' && event.text === 'Next answer.')).toBe(true);
  }, 180_000);

  it('closes an idle thread\'s processes and resumes on the next message', async () => {
    const { repo, stateRoot } = await fixture();
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    let opens = 0;
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot, idleMs: 100,
      openServers: (...args) => { opens++; return openO8Servers(...args); },
      transport: script([message([{ type: 'text', text: 'One.' }]), message([{ type: 'text', text: 'Two.' }])], seen) });
    backends.push(backend);
    await turn(backend, repo, 'First');
    const first = backend.peekSession(repo, undefined, 'thoughts-pi-test');
    expect(first?.status).toBe('ready');
    await new Promise(resolve => setTimeout(resolve, 600));
    const second = await turn(backend, repo, 'Second');
    expect(second.filter(event => event.type === 'error')).toEqual([]);
    expect(seen[1].messages.length).toBeGreaterThan(seen[0].messages.length);
    // The idle close ended the first processes, so the second message started new ones.
    expect(opens).toBe(2);
  }, 180_000);

  it('refuses the operator server without the ws token at the middleware gate', async () => {
    const response = await fetch(`${process.env.NEXT_ORIGIN}/api/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(response.status).toBe(401);
  });

  it('keeps a plan-mode turn read-only: proposer servers and no repo writes or commands', async () => {
    const { repo, stateRoot } = await fixture();
    const seen: Array<{ messages: unknown[]; tools: string[] }> = [];
    let approvals = 0;
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot, approve: async () => { approvals++; return true; },
      transport: script([call('w1', 'write_file', { path: 'plan.md', content: 'no' }), message([{ type: 'text', text: 'Read only.' }])], seen) });
    backends.push(backend);
    const out: OrchestratorEvent[] = [];
    await backend.sendTurn(repo, 'Plan only', event => out.push(event), { threadId: 'thoughts-pi-test', permissionMode: 'plan' });
    expect(seen[0].tools).toEqual(['read_file', 'o8_commands', 'o8_command_help', 'o8_run']);
    const result = out.find((event): event is Extract<OrchestratorEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(result?.isError).toBe(true);
    expect(approvals).toBe(0);
    await expect(readFile(join(repo, 'plan.md'), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('runs one turn per thread: an overlapping message is refused and Pi starts once', async () => {
    const { repo, stateRoot } = await fixture();
    let opens = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      openServers: async (...args) => { opens++; await gate; return openO8Servers(...args); },
      transport: script([message([{ type: 'text', text: 'Only one.' }])]) });
    backends.push(backend);
    const first: OrchestratorEvent[] = [];
    const running = backend.sendTurn(repo, 'First', event => first.push(event), { threadId: 'thoughts-pi-test' });
    const second = await turn(backend, repo, 'Second', {});
    expect(second.map(event => event.type)).toEqual(['error', 'done']);
    expect(backend.peekSession(repo, undefined, 'thoughts-pi-test')?.status).toBe('busy');
    release();
    await running;
    expect(first.filter(event => event.type === 'error')).toEqual([]);
    expect(opens).toBe(1);
  }, 180_000);

  it('closes a Pi that is still starting when the backend shuts down', async () => {
    const { repo, stateRoot } = await fixture();
    let closed = 0;
    let modelCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const backend = createPiOrchestratorBackend({ stateRoot: () => stateRoot,
      openServers: async (...args) => {
        await gate;
        const servers = await openO8Servers(...args);
        return { servers: servers.servers, close: async () => { closed++; await servers.close(); } };
      },
      transport: async function* () { modelCalls++; yield* events(message([{ type: 'text', text: 'Too late.' }])); } });
    const running = turn(backend, repo, 'Start');
    const shutdown = backend.closeAll();
    release();
    await Promise.all([running, shutdown]);
    expect(closed).toBe(1);
    // The started Pi is closed before it runs the message.
    expect(modelCalls).toBe(0);
    expect(backend.peekSession(repo, undefined, 'thoughts-pi-test')?.status).toBe('ready');
  }, 180_000);

  it('keeps transport diagnostics out of command results', async () => {
    const server = { name: 'cortex', request: async (method: string) => {
      if (method === 'tools/list') return { tools: [{ name: 'cortex_fleet_status', description: 'Fleet.', inputSchema: { type: 'object' } }] };
      throw new Error('JSON-RPC process exited (exit code 1)\nstderr: token=secret-value at /Users/someone/private');
    } };
    const commands = await listO8Commands([server], new AbortController().signal);
    const run = createO8CommandTools(commands).find(tool => tool.definition.name === 'o8_run')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await run.execute({ name: 'cortex_fleet_status', arguments: '{}' }, new AbortController().signal);
    expect(result.content[0].text).toBe('o8 command cortex_fleet_status could not reach the o8 cortex server.');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    warn.mockRestore();
  });

  it('is registered as the pi backend with orchestrator-sized limits', () => {
    expect(getOrchestratorBackend('pi').id).toBe('pi');
    expect(PI_ORCHESTRATOR_LIMITS.maxToolCalls).toBeGreaterThan(16);
  });
});
