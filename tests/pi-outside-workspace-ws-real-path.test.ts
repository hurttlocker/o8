import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildOrchestratorSendPayload } from '@/components/desktop/thoughts/use-orchestrator-stream/send-payload';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-permission-ws-')));
const repoPath = join(root, 'repo');
const dataDir = join(root, 'data');
const token = 'fixture-pi-permission-token';
let api: Server;
let child: ChildProcess;
let socket: WebSocket;
let wsPort = 0;
let output = '';
const events: Array<{ event?: string; data?: Record<string, unknown> }> = [];

async function waitFor(check: () => boolean, label: string, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Fixture server exited before ${label}: ${output.slice(-1500)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}: ${output.slice(-1500)}`);
}

beforeAll(async () => {
  buildPiWriteHelper();
  mkdirSync(repoPath); mkdirSync(dataDir);
  execFileSync('git', ['init', '-q', repoPath]);
  writeFileSync(join(dataDir, 'ws-token'), token, { mode: 0o600 });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'fixture-repo', name: 'repo', localPath: repoPath, addedAt: new Date().toISOString() },
  ] }));
  api = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/api/setup/identity' ? { configured: false } : { ready: true }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture API port.');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const probeAddress = probe.address();
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('Missing fixture WS port.');
  wsPort = probeAddress.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const home = join(root, 'home'); mkdirSync(home);
  child = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    'tests/fixtures/pi-outside-workspace-ws.ts'], { cwd: process.cwd(), env: {
    NODE_ENV: 'test', PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'),
    O8_TEST_PI_PERMISSION_ROOT: root, O8_API_PORT: String(address.port), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${address.port}`,
    ...(process.env.O8_TEST_FILE_MARKER ? { O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER } : {}),
  } });
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  await waitFor(() => output.includes('WebSocket server listening'), 'startup');
  socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
  socket.on('message', data => { events.push(JSON.parse(String(data))); });
  await once(socket, 'open');
}, 120_000);

afterAll(async () => {
  socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    if (!await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000))])) {
      child.kill('SIGKILL'); await exited;
    }
  }
  if (api?.listening) { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
  rmSync(root, { recursive: true, force: true });
});

it('carries the explicit composer choice through WS admission to an outside write and persisted turn receipt', async () => {
  const threadId = 'thoughts-pi-permission-ws';
  socket.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath, threadId, backend: 'pi' }));
  await waitFor(() => events.some(row => row.event === 'status'), 'subscription');
  socket.send(buildOrchestratorSendPayload({ repoPath, threadId, clientMessageId: 'outside-ws-send',
    wireMessage: 'Run the selected command.', displayMessage: 'Run the selected command.', permissionMode: 'outside-workspace',
    orchestrationMode: 'single', pickedMode: 'solo', model: 'pi', backend: 'pi', pinBackend: true }));
  await waitFor(() => events.some(row => row.event === 'status' && row.data?.receipt && row.data.status === 'ready'), 'completed turn');
  expect(events.filter(row => row.event === 'error')).toEqual([]);
  expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('changed');
  const history = JSON.parse(readFileSync(join(dataDir, 'chat-history', `${threadId}.json`), 'utf8'));
  expect(history.messages.find((row: { role: string }) => row.role === 'assistant').receipt.permissionMode).toBe('outside-workspace');
}, 90_000);
