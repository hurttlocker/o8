import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { buildToolRegistry, resetToolSpinePortIdentityForTests } from '@/lib/mcp/tool-spine/build';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const mcp = await import('@/app/api/mcp/route');
const projects = await import('@/app/api/panel/projects/route');
const { listProjects } = await import('@/lib/projects/store');
const { closeDb } = await import('@/lib/db');
const { prepareOwnedWorkerMcpConfig } = await import('@/lib/runtimes/shared/owned-session/worker-mcp-config');
const saved = { NEXT_ORIGIN: process.env.NEXT_ORIGIN, O8_API_PORT: process.env.O8_API_PORT };
const token = getOrCreateWsToken();
const api = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = new NextRequest(`http://${req.headers.host}${req.url}`, { method: req.method,
      headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
    const response = req.url === '/api/mcp' ? await mcp.POST(request)
      : req.url === '/api/panel/projects' ? (req.method === 'POST' ? await projects.POST(request) : await projects.GET())
        : new Response('{}', { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  } catch { res.writeHead(500).end(); }
});
beforeAll(async () => {
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const port = String((api.address() as AddressInfo).port);
  process.env.NEXT_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.O8_API_PORT = port;
  await writeFile(join(getDataDir(), 'api-port'), port);
  resetToolSpinePortIdentityForTests();
});
afterAll(async () => {
  api.closeAllConnections();
  await new Promise<void>(resolve => api.close(() => resolve()));
  closeDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetToolSpinePortIdentityForTests();
});
afterEach(() => vi.unstubAllEnvs());

type Tool = { name: string; inputSchema: Record<string, unknown> };
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
function json(result: Result) { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text); }
async function peerFor(config: { command: string; args: string[]; env?: Record<string, string> | null }) {
  const peer = new StdioJsonRpcPeer({ command: config.command, args: config.args, cwd: process.cwd(),
    env: { ...process.env, ...config.env } }, 30_000);
  await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'fixture-agent', version: '1' } });
  return peer;
}
async function call(peer: StdioJsonRpcPeer, name: string, args: Record<string, unknown>) {
  return peer.request<Result>('tools/call', { name, arguments: args });
}

describe('deferred o8 tools through generated runtime configs and real servers', () => {
  it('keeps restricted profiles, external client configs and explicit full loading on complete catalogs', () => {
    vi.stubEnv('O8_MCP_TOOL_LOADING', 'deferred');
    for (const profile of ['propose', 'solo', 'fable', 'fable-solo'] as const) {
      for (const emit of [toClaudeServersMap, toCodexServersMap]) {
        for (const config of Object.values(emit(buildToolRegistry(process.cwd(), { profile })))) {
          if (config.type === 'stdio') expect(config.env?.O8_MCP_TOOL_LOADING).not.toBe('deferred');
        }
      }
    }
    const desktop = toClaudeDesktopJson(buildToolRegistry(process.cwd()), {});
    expect(JSON.stringify(desktop)).not.toContain('"O8_MCP_TOOL_LOADING":"deferred"');
    vi.stubEnv('O8_MCP_TOOL_LOADING', 'full');
    for (const config of Object.values(toClaudeServersMap(buildToolRegistry(process.cwd())))) {
      if (config.type === 'stdio') expect(config.env?.O8_MCP_TOOL_LOADING).not.toBe('deferred');
    }
  });
  for (const [runtime, emit] of [['claude', toClaudeServersMap], ['codex', toCodexServersMap]] as const) {
    for (const server of ['operator', 'cortex']) {
      it(`${runtime}/${server} finds a non-core tool, calls it and persists the project`, async () => {
        const config = emit(buildToolRegistry(process.cwd()))[server];
        if (config.type !== 'stdio') throw new Error('Expected stdio');
        const peer = await peerFor({ ...config, env: { ...config.env, O8_MCP_TOOL_LOADING: 'deferred' } });
        try {
          const initial = await peer.request<{ tools: Tool[] }>('tools/list', {});
          const name = server === 'operator' ? 'o8_create_project' : 'cortex_create_project';
          expect(initial.tools.map(tool => tool.name)).not.toContain(name);
          expect(initial.tools.map(tool => tool.name)).toContain('o8_tool_search');
          expect(config.env?.O8_MCP_TOOL_LOADING).toBe('deferred');
          const found = json(await call(peer, 'o8_tool_search', { query: name }));
          expect(found.tools[0]).toMatchObject({ name, inputSchema: { type: 'object' } });
          const projectName = `Deferred ${runtime} ${server}`;
          json(await call(peer, 'o8_tool_call', { name, arguments: JSON.stringify({ name: projectName }) }));
          expect(listProjects().some(project => project.name === projectName)).toBe(true);
        } finally { await peer.close({ gracefulMs: 200 }); }
      });
    }
  }

  it('preserves the deferred setting in a registered worker attachment and runs its non-core tool', async () => {
    const config = toClaudeServersMap(buildToolRegistry(process.cwd())).operator;
    if (config.type !== 'stdio') throw new Error('Expected stdio');
    insertExternalMcpServer({ name: 'worker-o8', transport: 'stdio', command: config.command,
      args: config.args, env: config.env, workerInjection: true });
    const sessionDir = join(getDataDir(), 'worker-session');
    await mkdir(sessionDir, { recursive: true });
    const prepared = await prepareOwnedWorkerMcpConfig({ adapter: { workerMcpInjection: 'config-file' } as OwnedRuntimeAdapter,
      session: { packetId: 'pkt-deferred', repoPath: process.cwd(), sessionDir } as OwnedSessionRecord,
      runId: 'deferred', mode: 'launch', sandboxEnabled: false });
    const { mcpServers } = JSON.parse(await readFile(prepared.configPath!, 'utf8'));
    const peer = await peerFor(mcpServers['worker-o8']);
    try {
      const initial = await peer.request<{ tools: Tool[] }>('tools/list', {});
      expect(initial.tools.map(tool => tool.name)).not.toContain('o8_create_project');
      const found = json(await call(peer, 'o8_tool_search', { query: 'o8_create_project' }));
      expect(found.tools[0].name).toBe('o8_create_project');
      json(await call(peer, 'o8_tool_call', { name: found.tools[0].name, arguments: '{"name":"Deferred worker"}' }));
      expect(listProjects().some(project => project.name === 'Deferred worker')).toBe(true);
    } finally { await peer.close({ gracefulMs: 200 }); }
  });

  it('retains the complete catalog with full loading and enumerates every verb through search', async () => {
    const config = toClaudeServersMap(buildToolRegistry(process.cwd())).operator;
    if (config.type !== 'stdio') throw new Error('Expected stdio');
    const full = await peerFor({ ...config, env: { ...config.env, O8_MCP_TOOL_LOADING: 'full' } });
    const deferred = await peerFor({ ...config, env: { ...config.env, O8_MCP_TOOL_LOADING: 'deferred' } });
    try {
      const catalog = await full.request<{ tools: Tool[] }>('tools/list', {});
      expect(catalog.tools.length).toBeGreaterThan(100);
      const names: string[] = [];
      let offset: number | null = 0;
      do {
        const page = json(await call(deferred, 'o8_tool_search', { query: '', offset, limit: 10 }));
        names.push(...page.tools.map((tool: Tool) => tool.name));
        offset = page.nextOffset;
      } while (offset !== null);
      expect(names).toEqual(catalog.tools.map(tool => tool.name));
      const http = await mcp.POST(new Request('http://localhost/api/mcp', { method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
      expect((await http.json()).result.tools.map((tool: Tool) => tool.name)).toEqual(names);
    } finally { await full.close({ gracefulMs: 200 }); await deferred.close({ gracefulMs: 200 }); }
  });

  it('records before and after schema payloads from the actual built-in server processes', async () => {
    const payloads: Record<string, { before: Tool[]; after: Tool[] }> = {};
    for (const server of ['operator', 'cortex']) {
      const config = toClaudeServersMap(buildToolRegistry(process.cwd()))[server];
      if (config.type !== 'stdio') throw new Error('Expected stdio');
      const full = await peerFor({ ...config, env: { ...config.env, O8_MCP_TOOL_LOADING: 'full' } });
      const compact = await peerFor(config);
      try {
        const before = (await full.request<{ tools: Tool[] }>('tools/list', {})).tools;
        const after = (await compact.request<{ tools: Tool[] }>('tools/list', {})).tools;
        expect(Buffer.byteLength(JSON.stringify(after))).toBeLessThan(Buffer.byteLength(JSON.stringify(before)) / 2);
        payloads[server] = { before, after };
      } finally { await full.close({ gracefulMs: 200 }); await compact.close({ gracefulMs: 200 }); }
    }
    if (process.env.O8_TOOL_DEFINITION_RECEIPT) await writeFile(process.env.O8_TOOL_DEFINITION_RECEIPT, JSON.stringify(payloads));
  });

  for (const server of ['operator', 'cortex']) {
    it(`${server} keeps profile-hidden tools undiscoverable and uncallable`, async () => {
      const config = toClaudeServersMap(buildToolRegistry(process.cwd(), { profile: 'propose' }))[server === 'operator' ? 'visualizations' : server];
      if (config.type !== 'stdio') throw new Error('Expected stdio');
      const peer = await peerFor({ ...config, env: { ...config.env, O8_MCP_TOOL_LOADING: 'deferred' } });
      try {
        const name = server === 'operator' ? 'dispatch_mission' : 'cortex_launch_agent';
        expect(json(await call(peer, 'o8_tool_search', { query: name })).tools).toEqual([]);
        expect((await call(peer, 'o8_tool_call', { name, arguments: '{}' })).isError).toBe(true);
        expect((await call(peer, name, {})).isError).toBe(true);
      } finally { await peer.close({ gracefulMs: 200 }); }
    });
  }
});
