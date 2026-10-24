import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Same disposable host entry point as the native history/composer fixtures.
// The terminal mode must cross src/ws-server.ts and a real fixture PTY.
const credential = 'fixture-next-terminal-operator';
let child: ChildProcess;
let socket: WebSocket;
let origin = '';
let sessionName = '';
type Frame = { channel: string; event: string; data: Record<string, unknown> };
const frames: Frame[] = [];
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 35_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
beforeAll(async () => {
  child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
    '--import', 'tsx', 'scripts/next/dev-server.ts', '--terminal'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: credential }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', chunk => {
    output += String(chunk);
    for (const line of output.split('\n')) {
      try {
        const value = JSON.parse(line) as { origin?: string; terminalSession?: string };
        if (value.origin) { origin = value.origin; sessionName = value.terminalSession ?? ''; }
      } catch { /* startup status is not fixture metadata */ }
    }
  });
  // Drain private startup diagnostics without exposing paths or credentials.
  child.stderr!.resume();
  await until(() => Boolean(origin), 'disposable fixture origin');
}, 40_000);
afterAll(async () => {
  socket?.terminate();
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
});

it('attaches, replays, writes and resizes an existing fixture PTY through the production server', async () => {
  expect(sessionName, 'fixture host must publish an existing terminal session').toBe('cortex-next-terminal-fixture');
  const response = await fetch(`${origin}/api/panel/ws-info`, { headers: { Authorization: `Bearer ${credential}` } });
  expect(response.status).toBe(200);
  const info = await response.json() as { wsPort: number; wsToken: string };
  socket = new WebSocket(`ws://127.0.0.1:${info.wsPort}/ws?token=${encodeURIComponent(info.wsToken)}`);
  socket.on('message', raw => frames.push(JSON.parse(String(raw)) as Frame));
  await once(socket, 'open');
  const send = (body: Record<string, unknown>) => socket.send(JSON.stringify({ sessionName, ...body }));
  const text = () => frames.filter(f => f.channel === 'terminal' && f.event === 'data')
    .map(f => Buffer.from(String(f.data.data), 'base64').toString('utf8')).join('');
  send({ type: 'terminal-attach', cols: 80, rows: 24 });
  await until(() => frames.some(f => f.event === 'attached'), 'production attach');
  send({ type: 'terminal-visibility', visible: true, epoch: 1, needsResync: true });
  await until(() => frames.some(f => f.event === 'resync'), 'production replay barrier');
  const replay = frames.find(f => f.event === 'resync')!;
  expect(Buffer.from(String(replay.data.data), 'base64').toString('utf8')).toContain('READY');
  send({ type: 'terminal-input', data: 'key\r' });
  await until(() => text().includes('KEY'), 'fixture PTY input');
  expect(text()).toContain('\x1b[31m');
  expect(text()).toContain('界');
  send({ type: 'terminal-resize', cols: 96, rows: 31 });
  send({ type: 'terminal-input', data: 'size\r' });
  await until(() => text().includes('SIZE 96 31'), 'kernel PTY resize');
  send({ type: 'terminal-input', data: 'alt\r' });
  await until(() => text().includes('\x1b[?1049h'), 'alternate screen');
  send({ type: 'terminal-input', data: 'primary\r' });
  await until(() => text().includes('\x1b[?1049l'), 'primary screen');
}, 30_000);
