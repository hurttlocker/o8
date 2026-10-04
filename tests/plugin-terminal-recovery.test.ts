import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { beforeAll, describe, expect, it } from 'vitest';

async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.kill('SIGTERM'); await exited; clearTimeout(timer);
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe.skipIf(process.platform === 'win32')('built plugin CLI and persistent host crash recovery', () => {
  beforeAll(() => { execFileSync('tmux', ['-V']); execFileSync(process.execPath, ['cli/esbuild.config.mjs']); });
  it.each(['before-spawn', 'after-spawn', 'inspection'])('preserves the receipt and never relaunches after %s', async (fault) => {
    const root = realpathSync(mkdtempSync('/tmp/o8-plugin-recovery-'));
    const data = path.join(root, 'data'); mkdirSync(data);
    const tmuxServer = `o8-plugin-recovery-${randomUUID()}`;
    const token = 'plugin-terminal-test-operator';
    writeFileSync(path.join(data, 'ws-token'), `${token}\n`, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', O8_DATA_DIR: data, O8_DASH_TMUX_SERVER_NAME: tmuxServer, O8_PERSISTENT_TERMINALS: '1', O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER };
    let host: ChildProcess | undefined; let ws: ChildProcess | undefined; let socket: WebSocket | undefined;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', tmuxServer, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const start = async (injectedFault?: string) => {
      host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', './tests/fixtures/action-plugin-terminal-host.ts'], { env: { ...env, O8_TEST_TERMINAL_FAULT: injectedFault }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      host.stdout!.on('data', (chunk: Buffer) => { output += chunk; });
      host.stderr!.on('data', (chunk: Buffer) => { errors += chunk; });
      await until(() => { if (host!.exitCode !== null) throw new Error(errors); return /\{"port":(\d+)\}/.test(output); }, 'operator route process');
      return Number(output.match(/\{"port":(\d+)\}/)![1]);
    };
    const cli = (port: number, args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const command = spawn(process.execPath, ['cli/dist/o8.mjs', ...args], { env: { ...env, O8_API_PORT: String(port), O8_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      command.stdout.on('data', (chunk: Buffer) => { out += chunk; }); command.stderr.on('data', (chunk: Buffer) => { err += chunk; });
      const timer = setTimeout(() => command.kill('SIGKILL'), 35_000);
      command.on('error', reject); command.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });
    try {
      let port = await start(fault);
      const reviewed = await cli(port, ['plugin', 'source', 'review', '--directory', path.join(process.cwd(), 'examples/action-plugins/interactive-console')]);
      expect(reviewed.code, reviewed.err).toBe(0);
      const review = JSON.parse(reviewed.out).review;
      expect((await cli(port, ['plugin', 'source', 'link', '--directory', review.sourceDirectory, '--revision', review.revision])).code).toBe(0);
      const id = randomUUID(); const sessionName = `cortex-dash-${id.replaceAll('-', '')}`;
      const args = ['plugin', 'terminal', 'launch', 'interactive-console', 'console', '--revision', review.revision, '--request', id];
      const launched = await cli(port, args);
      expect(launched.code).not.toBe(0);
      if (fault !== 'inspection') expect(launched.err + launched.out).toContain(id);
      // Read the independently committed record before restarting the route host.
      const database = new Database(path.join(data, 'customizations/actions/receipts.sqlite'));
      const record = database.prepare('SELECT receipt_json FROM terminal_receipts WHERE id=?').get(id) as { receipt_json: string };
      database.close();
      expect(JSON.parse(record.receipt_json)).toMatchObject({ id, status: 'launching', sessionName });
      await stop(host); port = await start();
      const replay = await cli(port, args);
      const terminal = JSON.parse(replay.out).terminal;
      expect(terminal).toMatchObject({ id, sessionName, status: fault === 'before-spawn' ? 'launching' : 'running' });
      const replacement = await cli(port, [...args.slice(0, -2), '--request', randomUUID()]);
      expect(replacement.code).toBe(5);
      if (fault === 'before-spawn') expect(() => tmux('has-session', '-t', sessionName)).toThrow();
      else {
        const panePid = tmux('display-message', '-p', '-t', sessionName, '#{pane_pid}').trim();
        expect(tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')).toEqual([sessionName]);
        if (fault === 'after-spawn') {
          const wsPort = await freePort();
          let errors = '';
          ws = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'src/ws-server.ts'], { env: { ...env, O8_API_PORT: String(port), O8_WS_PORT: String(wsPort), NEXT_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
          ws.stderr!.on('data', (chunk: Buffer) => { errors += chunk; }); ws.stdout!.on('data', () => {});
          await until(async () => { if (ws!.exitCode !== null) throw new Error(errors); try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; } }, 'actual WS terminal host', 30_000);
          for (const marker of ['FIRST', 'RECONNECTED']) {
            const frames: Array<{ channel: string; event: string; data?: { data?: string } }> = [];
            socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
            socket.on('message', (raw) => frames.push(JSON.parse(String(raw)))); await once(socket, 'open');
            await until(() => frames.some((frame) => frame.event === 'connected'), 'authenticated websocket');
            socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 100, rows: 24 }));
            await until(() => frames.some((frame) => frame.event === 'attached'), 'plugin PTY attachment');
            socket.send(JSON.stringify({ type: 'terminal-input', sessionName, data: `${marker}\n` }));
            await until(() => frames.filter((frame) => frame.channel === 'terminal' && frame.event === 'data').map((frame) => Buffer.from(frame.data?.data ?? '', 'base64').toString()).join('').includes(`You typed: ${marker}`), 'plugin interactive reply');
            socket.send(JSON.stringify({ type: 'terminal-detach', sessionName })); socket.close(); await once(socket, 'close'); socket = undefined;
          }
          expect(tmux('display-message', '-p', '-t', sessionName, '#{pane_pid}').trim()).toBe(panePid);
          expect(tmux('capture-pane', '-p', '-S', '-', '-t', sessionName)).toContain('You typed: RECONNECTED');
          await stop(ws); ws = undefined;
          expect(tmux('has-session', '-t', sessionName)).toBe('');
        }
      }
      expect((await cli(port, ['plugin', 'terminal', 'stop', id])).code).toBe(0);
      expect(JSON.parse((await cli(port, args)).out).terminal.status).toBe('stopped');
      expect(() => tmux('has-session', '-t', sessionName)).toThrow();
    } finally {
      socket?.terminate(); await stop(ws); await stop(host);
      try { tmux('kill-server'); } catch { /* owned server may already be gone */ }
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
