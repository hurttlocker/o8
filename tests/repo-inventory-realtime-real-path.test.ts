/**
 * #3559: a repository registered or a project switched through the server (an
 * MCP command or the CLI calls these routes) reaches the open window without a
 * reload. The real routes publish to the real ws-server process; a WebSocket
 * client receives the realtime batch; the window listener gets that exact frame
 * and asks the repository and project views to reload.
 */
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type WireFrame = { channel?: string; event?: string; data?: { events?: Array<{ data?: { mutation?: Record<string, unknown> } }> } };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}. ${serverOutput.slice(-1_500)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const apiPort = await freePort();
const wsPort = await freePort();
process.env.CORTEX_REALTIME_INTERNAL_ORIGIN = `http://127.0.0.1:${wsPort}`;
const { getDataDir } = await import('@/lib/data-dir-migration');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { POST: reposPost } = await import('@/app/api/panel/repos/route');
const { POST: projectsPost } = await import('@/app/api/panel/projects/route');
const { POST: activePost } = await import('@/app/api/panel/projects/active/route');
// The desktop window, after the server modules load: the listener registers when the projects module loads.
vi.stubGlobal('window', new EventTarget());
await import('@/components/desktop/repo-registry/useProjects');

const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'o8-repo-inventory-')));
const token = getOrCreateWsToken();
let apiServer: Server;
let wsProcess: ChildProcess;
let serverOutput = '';
const frames: WireFrame[] = [];
let socket: WebSocket;

function mutations(action: string) {
  return frames.filter((frame) => frame.channel === 'realtime' && frame.event === 'batch'
    && frame.data?.events?.some((event) => event.data?.mutation?.action === action));
}

function post(handler: (request: NextRequest) => Promise<Response>, url: string, body: unknown) {
  return handler(new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

/** Hands one received frame to the window, as the desktop WebSocket bridge does. */
function deliver(frame: WireFrame) {
  const heard: string[] = [];
  const record = (event: Event) => heard.push(event.type);
  window.addEventListener('o8:repos-changed', record);
  window.addEventListener('o8:projects-updated', record);
  window.dispatchEvent(new CustomEvent('o8:realtime', { detail: { channel: frame.channel, event: frame.event, data: frame.data } }));
  window.removeEventListener('o8:repos-changed', record);
  window.removeEventListener('o8:projects-updated', record);
  return heard.sort();
}

beforeAll(async () => {
  apiServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    if (url.pathname === '/api/command-center/snapshot') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        fleet: { agents: [], meta: { mode: 'live' } }, review: null, reviewError: null,
        browserInventory: { browsers: [], generatedAt: new Date().toISOString() }, attachedBrowser: null, browserError: null,
      }));
      return;
    }
    if (url.pathname === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ configured: false }));
      return;
    }
    response.writeHead(404).end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  wsProcess = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, CORTEX_IDE_DATA_DIR: getDataDir(), O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}` },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok || undefined; } catch { return undefined; }
  }, 'ws server health', 30_000);
  socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as WireFrame));
  await once(socket, 'open');
  await waitFor(() => frames.find((frame) => frame.channel === 'system' && frame.event === 'connected'), 'connection welcome');
  // The desktop subscribes to the global stream once connected.
  socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
  await waitFor(() => frames.find((frame) => frame.channel === 'realtime' && frame.event === 'batch'), 'global stream bootstrap');
}, 60_000);

afterAll(async () => {
  socket?.close();
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  vi.unstubAllGlobals();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('server-side repository and project changes reach the open window (#3559)', () => {
  it('reloads repositories after a repository is registered through the server', async () => {
    const repoPath = join(repoRoot, 'registered');
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(join(repoPath, 'README.md'), 'registered\n');
    execFileSync('git', ['-C', repoPath, '-c', 'user.name=o8', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'init', '--allow-empty']);

    // A refused registration changes nothing and announces nothing.
    expect((await post(reposPost, '/api/panel/repos', { action: 'add', localPath: '' })).status).toBe(400);
    expect((await post(reposPost, '/api/panel/repos', { action: 'add', localPath: repoPath })).status).toBe(201);
    const frame = await waitFor(() => mutations('repo-register')[0], 'repository registration mutation');
    expect(mutations('repo-register')).toHaveLength(1);
    expect(deliver(frame)).toEqual(['o8:projects-updated', 'o8:repos-changed']);
  }, 60_000);

  it('reloads the sidebar project after a project is switched through the server', async () => {
    const created = await post(projectsPost, '/api/panel/projects', { name: 'Inventory fixture' });
    expect(created.status).toBe(200);
    const ledger = await created.json() as { projects: Array<{ id: string; name: string }> };
    const project = ledger.projects.find((entry) => entry.name === 'Inventory fixture')!;
    expect((await post(activePost, '/api/panel/projects/active', { projectId: project.id })).status).toBe(200);
    const frame = await waitFor(() => mutations('project-switch')[0], 'project switch mutation');
    expect(deliver(frame)).toEqual(['o8:projects-updated', 'o8:repos-changed']);
  }, 60_000);

  it('ignores realtime mutations that are not inventory changes', () => {
    expect(deliver({ channel: 'realtime', event: 'batch', data: { events: [{ data: { mutation: { runtime: 'codex', action: 'launch' } } }] } })).toEqual([]);
  });
});
