/**
 * #3657 / #3664: a worker launch the server refuses must reach the orchestrator
 * with its reason, and the orchestrator must be able to see which runtime ids
 * exist. Drives the real cortex MCP server process; case A also serves the real
 * `/api/orchestrator/delegate` route on a machine with no Pi CLI.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { NextRequest } from 'next/server';

import { afterAll, describe, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'o8-launch-errors-')));
const dataDir = join(root, 'data');
const home = join(root, 'home');
const repoPath = join(root, 'repo');
mkdirSync(dataDir);
mkdirSync(home);
// No Pi CLI anywhere the resolver looks: an empty home, a PATH with only node and git.
for (const [key, value] of Object.entries({
  O8_DATA_DIR: dataDir,
  CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
  HOME: home,
  PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
  O8_PI_BIN: join(root, 'missing-pi'),
  SHELL: '/bin/sh',
})) vi.stubEnv(key, value);

const { POST: delegatePost } = await import('@/app/api/orchestrator/delegate/route');

const STORAGE_NOTE = 'Dispatch held by storage admission (reserve_breached). Storage policy keeps 5% of disk or 10.0 GB, whichever is greater, unallocated. This volume requires 23.3 GB free; 8.1 GB is available. The volume is 15.2 GB below that reserve. Free 15.2 GB more to dispatch this packet\'s 64.1 MB estimate while preserving the reserve.';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('API fixture did not bind a TCP port.');
  return address.port;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { raw += chunk; });
    request.on('end', () => resolve(raw));
  });
}

function startMcp(port: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import=tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      CORTEX_API_BASE: `http://127.0.0.1:${port}`,
      O8_MCP_NODE22_CHECKED: '1',
      WS_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function rpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params: unknown, timeoutMs = 60_000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
    const onData = (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        const response = JSON.parse(line) as { id?: number };
        if (response.id === id) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(response as Record<string, unknown>);
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function toolText(response: Record<string, unknown>): string {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.map((part) => part.text ?? '').join('') ?? JSON.stringify(response);
}

async function stop(child: ChildProcessWithoutNullStreams, server: Server) {
  child.stdin.end();
  await Promise.race([
    once(child, 'exit'),
    new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000)),
  ]);
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('cortex_launch_agent runtime errors (#3657, #3664)', () => {
  it('A: refuses a runtime that is not installed before opening a lane, naming the built-in Pi worker', { timeout: 120_000 }, async () => {
    mkdirSync(repoPath);
    const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Launch Fixture');
    git('config', 'user.email', 'launch@example.test');
    writeFileSync(join(repoPath, 'notes.txt'), 'count = 1\n');
    git('add', 'notes.txt');
    git('commit', '-qm', 'fixture');
    let status = 0;
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== 'POST' || request.url !== '/api/orchestrator/delegate') {
        response.writeHead(404);
        response.end();
        return;
      }
      const result = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await readBody(request),
      }));
      status = result.status;
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    });
    const child = startMcp(await listen(server));
    try {
      const reply = await rpc(child, 1, 'tools/call', {
        name: 'cortex_launch_agent',
        arguments: {
          prompt: 'Append worker = yes to notes.txt and commit it.',
          repoPath,
          taskName: 'Append worker marker',
          runtime: 'pi',
          checkoutMode: 'isolated',
        },
      });
      const text = toolText(reply);
      expect(status).toBe(400);
      expect(text).toContain('"pi"');
      expect(text).toMatch(/not installed/i);
      expect(text).toContain('"pi-builtin"');
      expect(text).not.toMatch(/o8 API error/);
      // Refused before any lane or packet existed.
      const { listLanes } = await import('@/lib/lane/registry');
      expect(listLanes().filter((lane) => lane.repoPath === repoPath)).toEqual([]);
    } finally {
      await stop(child, server);
    }
  });

  it('B: passes a route-written refusal reason through, such as a storage hold', { timeout: 60_000 }, async () => {
    const server = createServer((request, response) => {
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, laneId: 'lane-fixture', packetId: 'pkt-fixture', error: STORAGE_NOTE }));
    });
    const child = startMcp(await listen(server));
    try {
      const reply = await rpc(child, 1, 'tools/call', {
        name: 'cortex_launch_agent',
        arguments: { prompt: 'Append a line.', repoPath: '/tmp/o8-launch-errors-fixture', runtime: 'pi-builtin' },
      });
      const text = toolText(reply);
      expect(text).toContain(STORAGE_NOTE);
      expect(text).not.toMatch(/o8 API error/);
    } finally {
      await stop(child, server);
    }
  });

  it('C: lists the valid runtime ids in the launch tool schema', { timeout: 60_000 }, async () => {
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const child = startMcp(await listen(server));
    try {
      const reply = await rpc(child, 1, 'tools/list', {});
      const tools = (reply.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string; enum?: string[] }> } }> }).tools;
      const runtime = tools.find((tool) => tool.name === 'cortex_launch_agent')!.inputSchema.properties.runtime;
      expect(runtime.enum).toEqual(expect.arrayContaining(['pi-builtin', 'pi', 'codex', 'claude-code']));
      expect(runtime.description).toMatch(/pi-builtin/);
      expect(runtime.description).toMatch(/own Pi/i);
    } finally {
      await stop(child, server);
    }
  });
});
