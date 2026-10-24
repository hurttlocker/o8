import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-terminal-echo-'));
const token = 'isolated-terminal-echo-fixture';
type Frame = { event?: string; data?: { sessionName?: string; data?: string; historical?: boolean; error?: string } };
let child: ChildProcess;
let api: Server;
let socket: WebSocket;
let bridgePort: number;
let sessionName: string;
let output = '';
const frames: Frame[] = [];
let liveBytes = 0;
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Starting listener or receipt. */ }
    if (child?.exitCode != null) throw new Error(`Fixture exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${label}. ${output.slice(-2000)}`);
}
function input(data: string) { socket.send(JSON.stringify({ type: 'terminal-input', sessionName, data })); }
function liveOutput(start: number) {
  return frames.slice(start).filter((frame) => frame.event === 'data' && !frame.data?.historical)
    .map((frame) => Buffer.from(frame.data!.data!, 'base64').toString('utf8'));
}
async function receipt() {
  const path = join(directory, 'echo-receipt.json');
  const previous = (() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })();
  input('report');
  await waitFor(() => readFileSync(path, 'utf8') !== previous, 'fresh server receipt');
  const serialized = readFileSync(path, 'utf8');
  if (process.env.O8_ECHO_EVIDENCE_PATH) writeFileSync(process.env.O8_ECHO_EVIDENCE_PATH, serialized);
  return JSON.parse(serialized) as {
    echoMs: number[]; delayedMs: number[]; floodBytes: number; floodMessages: number; floodStart: number; floodEnd: number;
  };
}
beforeAll(async () => {
  api = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.startsWith('/api/panel/repos') ? { repos: [] } : {}));
  });
  const apiPort = await listen(api);
  const reservation = createServer(); const port = await listen(reservation);
  bridgePort = port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
  child = execFile(process.execPath, ['--require=./tests/helpers/terminal-echo-preload.cjs',
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: directory, USERPROFILE: directory,
      O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'db.sqlite'),
      CORTEX_IDE_REVIEW_REPO_ROOT: directory, O8_API_PORT: String(apiPort), O8_WS_PORT: String(port),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_ECHO_FIXTURE_DIR: directory,
      O8_PERSISTENT_TERMINALS: '0', O8_SILENT_EXIT_DETECTOR_ENABLED: '0' },
  });
  child.stdout?.on('data', (value) => { output = (output + String(value)).slice(-16000); });
  child.stderr?.on('data', (value) => { output = (output + String(value)).slice(-16000); });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'server health', 30_000);
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  socket.on('message', (value) => {
    const frame = JSON.parse(value.toString()) as Frame;
    if (frame.event === 'data' && !frame.data?.historical) {
      const bytes = Buffer.from(frame.data!.data!, 'base64');
      liveBytes += bytes.length;
      // Count the flood without retaining 50 MB in the test process.
      if (bytes[0] === 126) return;
    }
    frames.push(frame);
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'terminal-create', directPty: true, cols: 90, rows: 12 }));
  await waitFor(() => frames.some((frame) => frame.event === 'created'), 'terminal reservation');
  sessionName = frames.find((frame) => frame.event === 'created')!.data!.sessionName!;
  socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 90, rows: 12 }));
  await waitFor(() => frames.some((frame) => frame.event === 'attached'), 'real terminal attachment');
}, 40_000);
afterAll(async () => {
  socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
    if (!stopped) { child.kill('SIGKILL'); await exited; }
  }
  api?.closeAllConnections();
  if (api?.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});
it('sends accepted small echoes through the real attach path with server p95 below 8 ms', async () => {
  for (let index = 0; index < 30; index += 1) {
    input(`echo:${index}`);
    await waitFor(() => liveOutput(0).join('').includes(`@echo:${index}@`), 'echo');
  }
  const result = await receipt();
  const sorted = [...result.echoMs].sort((left, right) => left - right);
  console.log(`ECHO_SERVER p50=${sorted[14].toFixed(3)}ms p95=${sorted[28].toFixed(3)}ms samples=${sorted.length}`);
  expect(sorted).toHaveLength(30);
  expect(sorted[28]).toBeLessThan(8);
});
it('keeps sustained 50 MB output on the existing 16 ms batch cadence', async () => {
  const start = liveBytes;
  input('flood');
  await waitFor(() => liveBytes - start === 50 * 1024 * 1024, '50 MB flood', 15_000);
  const result = await receipt();
  const rate = result.floodMessages * 1000 / (result.floodEnd - result.floodStart);
  console.log(`FLOOD bytes=${result.floodBytes} messages=${result.floodMessages} rate=${rate.toFixed(2)}/s duration=${(result.floodEnd - result.floodStart).toFixed(1)}ms`);
  expect(result.floodBytes).toBe(50 * 1024 * 1024);
  expect(rate).toBeLessThanOrEqual(65);
});
it('bounds a small-output burst to one immediate send and preserves byte order', async () => {
  const start = frames.length;
  input('burst');
  await waitFor(() => liveOutput(start).join('').length === 1024, 'burst');
  const chunks = liveOutput(start);
  expect(chunks.join('')).toBe([0, 1, 2, 3].map((value) => String(value).repeat(256)).join(''));
  expect(chunks).toHaveLength(2);
  expect(chunks[0]).toBe('0'.repeat(256));
});
it('does not flush an existing large batch early when another input arrives', async () => {
  const start = frames.length;
  // The same socket delivers these in order, before the queued batch timer.
  input('queued'); input('echo:100');
  await waitFor(() => liveOutput(start).join('').endsWith('@echo:100@'), 'queued output');
  expect(liveOutput(start)).toEqual(['Q'.repeat(2048) + '@echo:100@']);
});
it('expires the interactive credit before delayed background output', async () => {
  const start = frames.length;
  input('delayed');
  await waitFor(() => liveOutput(start).includes('delayed-output'), 'delayed output');
  const result = await receipt();
  expect(result.delayedMs).toHaveLength(1);
  expect(result.delayedMs[0]).toBeGreaterThanOrEqual(10);
});
it('keeps read-only input rejected and hidden viewers on their coalesced path', async () => {
  const viewer = new WebSocket(`ws://127.0.0.1:${bridgePort}/ws?token=${token}`);
  const seen: Array<{ frame: Frame; at: number }> = [];
  viewer.on('message', (value) => seen.push({ frame: JSON.parse(value.toString()) as Frame, at: performance.now() }));
  try {
    await once(viewer, 'open');
    viewer.send(JSON.stringify({ type: 'terminal-attach', sessionName, readOnly: true }));
    await waitFor(() => seen.some(({ frame }) => frame.event === 'attached'), 'observer attach');
    viewer.send(JSON.stringify({ type: 'terminal-visibility', sessionName, visible: false, epoch: 1 }));
    // Input and visibility are ordered on this socket. A rejected write cannot echo.
    viewer.send(JSON.stringify({ type: 'terminal-input', sessionName, data: 'echo:999' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(liveOutput(0).join('')).not.toContain('@echo:999@');
    const start = seen.length;
    const sent = performance.now();
    input('echo:101');
    await waitFor(() => liveOutput(0).join('').includes('@echo:101@'), 'controller echo');
    await waitFor(() => seen.slice(start).some(({ frame }) => frame.event === 'data' && !frame.data?.historical), 'hidden delivery');
    const delivery = seen.slice(start).find(({ frame }) => frame.event === 'data' && !frame.data?.historical)!;
    expect(Buffer.from(delivery.frame.data!.data!, 'base64').toString()).toBe('@echo:101@');
    expect(delivery.at - sent).toBeGreaterThanOrEqual(175);
  } finally { viewer.terminate(); }
});
