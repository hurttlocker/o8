// @vitest-environment jsdom
import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as NodeWebSocket } from 'ws';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const view = vi.hoisted(() => ({ output: '' }));
vi.mock('@/components/desktop/workspace-terminal/XtermPanel', async () => {
  const React = await import('react');
  return { XtermPanel: React.forwardRef(function Terminal(props: { tmuxSession: string; sendTerminalAttach: (session: string, cols: number, rows: number) => void; sendTerminalDetach: (session: string) => void }, ref) {
    const { tmuxSession, sendTerminalAttach, sendTerminalDetach } = props;
    React.useImperativeHandle(ref, () => ({ writeData: (data: string) => { view.output += Buffer.from(data, 'base64').toString('utf8'); }, focus: () => {}, setExited: () => {} }));
    React.useEffect(() => {
      sendTerminalAttach(tmuxSession, 90, 12);
      return () => sendTerminalDetach(tmuxSession);
    }, [tmuxSession, sendTerminalAttach, sendTerminalDetach]);
    return createElement('div', {}, 'Terminal view fixture');
  }) };
});
const { OnboardingSignInTerminal } = await import('@/components/desktop/onboarding/OnboardingSignInTerminal');
const dataDir = mkdtempSync(join(tmpdir(), 'o8-onboarding-terminal-'));
const token = 'isolated-onboarding-terminal-test';
const sockets: NodeWebSocket[] = [];
let api: Server;
let child: ChildProcess;
let root: Root;
let output = '';
let bridgePort = 0;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return (server.address() as { port: number }).port;
}
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let done = false;
    await act(async () => { done = await check(); await new Promise((resolve) => setTimeout(resolve, 25)); });
    if (done) return;
  }
  throw new Error(`Timed out: ${description}. ${output.slice(-1500)}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Run sign-in command');

beforeAll(async () => {
  api = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); });
  const apiPort = await listen(api);
  const reservation = createServer(); const wsPort = await listen(reservation);
  bridgePort = wsPort;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  writeFileSync(join(dataDir, 'ws-token'), token, { mode: 0o600 });
  child = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir, O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort), NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_PERSISTENT_TERMINALS: '1' },
  });
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; } }, 'isolated bridge health', 30_000);
  (window as Window & { __O8_WS_PORT__?: number }).__O8_WS_PORT__ = wsPort;
  const meta = document.createElement('meta'); meta.name = 'ws-token'; meta.content = token; document.head.append(meta);
  vi.stubGlobal('WebSocket', class TestWebSocket extends NodeWebSocket {
    constructor(url: string) { super(url); sockets.push(this); }
  });
}, 40_000);
afterAll(async () => {
  await act(async () => root?.unmount());
  for (const socket of sockets) socket.close();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  api?.closeAllConnections(); if (api?.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
  document.body.replaceChildren(); document.querySelector('meta[name="ws-token"]')?.remove();
  delete (window as Window & { __O8_WS_PORT__?: number }).__O8_WS_PORT__;
  vi.unstubAllGlobals(); rmSync(dataDir, { recursive: true, force: true });
});

it('drops a resized pending reservation when its transport closes before attach', async () => {
  type Frame = { event?: string; data?: { sessionName?: string; error?: string } };
  const connect = async () => {
    const socket = new NodeWebSocket(`ws://127.0.0.1:${bridgePort}/ws?token=${token}`); sockets.push(socket);
    const frames: Frame[] = []; socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame));
    await once(socket, 'open'); return { socket, frames };
  };
  const first = await connect();
  const ownerKey = `onboarding-sign-in:pending-${process.pid}`;
  first.socket.send(JSON.stringify({ type: 'terminal-create', ownerKey, requestId: ownerKey, directPty: true, cols: 90, rows: 12 }));
  await waitFor(() => first.frames.some((frame) => frame.event === 'created'), 'pending reservation');
  const sessionName = first.frames.find((frame) => frame.event === 'created')!.data!.sessionName!;
  first.socket.send(JSON.stringify({ type: 'terminal-resize', sessionName, cols: 80, rows: 10 }));
  const offset = output.length; first.socket.close();
  await waitFor(() => output.slice(offset).includes('Client disconnected'), 'pending owner disconnect');
  const next = await connect();
  next.socket.send(JSON.stringify({ type: 'terminal-create', ownerKey, requestId: ownerKey, directPty: true, cols: 90, rows: 12 }));
  await waitFor(() => next.frames.some((frame) => frame.event === 'created'), 'new pending reservation');
  next.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: 90, rows: 12, readOnly: true }));
  await waitFor(() => next.frames.some((frame) => frame.event === 'error'), 'unstarted reservation remains unmaterialized');
  expect(next.frames.find((frame) => frame.event === 'error')?.data?.error).toBe('Cannot observe a terminal that has not started.');
  expect(next.frames.some((frame) => frame.event === 'attached')).toBe(false);
  next.socket.close();
});

it('uses the real provider and PTY without auto-run, then terminates on close and transport loss', async () => {
  for (const closeThrough of ['view', 'transport'] as const) {
    const marker = join(dataDir, `${closeThrough}.pid`);
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    view.output = '';
    await act(async () => root.render(createElement(OnboardingSignInTerminal, {
      command: `printf '%s' "$$" > '${marker}'; printf 'O8_SIGN_IN_TEST_READY\\n'`,
      onClose: () => root.render(null),
    })));
    await waitFor(() => Boolean(runButton() && !runButton()!.disabled), 'ready sign-in terminal');
    expect(existsSync(marker)).toBe(false);
    await act(async () => runButton()!.click());
    await waitFor(() => existsSync(marker) && view.output.includes('O8_SIGN_IN_TEST_READY'), 'explicit command output');
    const pid = Number(readFileSync(marker, 'utf8'));
    expect(alive(pid)).toBe(true);
    if (closeThrough === 'view') {
      const close = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Close terminal')!;
      await act(async () => close.click());
    } else await act(async () => sockets.at(-1)!.close());
    await waitFor(() => !alive(pid), `${closeThrough} stops the owned PTY`);
    expect(readFileSync(marker, 'utf8')).toBe(String(pid));
    await act(async () => root.unmount()); host.remove();
  }
}, 30_000);
