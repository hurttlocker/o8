/**
 * Verify the Symon Agent Mode `symon` WS channel end-to-end.
 *
 *   npx tsx scripts/verify-symon-agent-mode.ts
 *
 * The live o8 app is not reachable from a worktree (the tool relay needs the
 * webview eval bridge), so — exactly as docs/internals/symon-agent-mode.md §Verification
 * allows — this spins up the REAL ws-server locally pointed at a STUB tool route
 * and drives the channel a phone would:
 *
 *   1. connect + subscribe (system:connected)
 *   2. symon-agent-status connecting → live
 *   3. symon-tool-call { tool: o8_status }  (a ReadOnly tool)
 *   4. assert: a correlated symon-tool-result (same callId) arrives, AND the
 *      acting → live status pair brackets it.
 *
 * It proves the ws-server relay + correlation + status transitions without the
 * app. Exit 0 = all assertions passed; the evidence tail is printed at the end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { withServerOnlyStubNodeOptions } from './run-lib.mjs';

const WS_TOKEN = 'verify-symon-agent-mode-token-0123456789';
const WS_PORT = 34000 + Math.floor(Math.random() * 4000);
const evidence: string[] = [];
function log(line: string) {
  const stamped = `${new Date().toISOString().slice(11, 23)}  ${line}`;
  evidence.push(stamped);
  console.log(stamped);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface Stub {
  server: Server;
  port: number;
  /** Mutable counter — read live after the run. */
  stats: { toolCalls: number };
}

// ── Stub Next: the readiness probe, the desk-status poll, and the tool relay. ──
function startStub(): Promise<Stub> {
  const stats = { toolCalls: 0 };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'GET' && url.startsWith('/api/panel/status')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Desk-preemption sweep reads desk status here — report idle so the phone
      // session is never falsely preempted during the run.
      if (req.method === 'GET' && url.startsWith('/api/mobile/symon')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ready: true, status: 'idle', agentSession: null }));
        return;
      }
      if (req.method === 'POST' && url.startsWith('/api/mobile/symon/tool')) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          stats.toolCalls += 1;
          let tool = '?';
          try { tool = JSON.parse(body).tool; } catch { /* ignore */ }
          // Canned ReadOnly result — shape the desk client would hand the model.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { stub: true, tool, running: 0, note: 'stub o8_status' } }));
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, stats });
    });
  });
}

async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-verify-symon-'));
  writeFileSync(path.join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');

  const stub = await startStub();
  log(`stub Next listening on 127.0.0.1:${stub.port} (tool route + readiness + desk-status)`);

  // Spawn the REAL ws-server the same way `npm run dev:ws` does (tsx resolves the
  // @/ alias; the server-only stub neutralizes server-only imports).
  const child: ChildProcess = spawn(
    'npx',
    ['tsx', 'src/ws-server.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: withServerOnlyStubNodeOptions(),
        NEXT_ORIGIN: `http://127.0.0.1:${stub.port}`,
        WS_TOKEN,
        WS_PORT: String(WS_PORT),
        O8_WS_PORT: String(WS_PORT),
        O8_API_PORT: String(stub.port),
        CORTEX_IDE_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d) => {
    const s = String(d).trim();
    if (s.includes('listening') || s.includes('[symon') || s.includes('WS token')) log(`[ws-server] ${s.split('\n')[0]}`);
  });
  child.stderr?.on('data', (d) => {
    const s = String(d).trim();
    if (s && !s.startsWith('(node:')) log(`[ws-server:err] ${s.split('\n')[0]}`);
  });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    try { stub.server.close(); } catch { /* gone */ }
  };

  // ── Connect (retry until the ws-server is listening) ──
  const url = `ws://127.0.0.1:${WS_PORT}/ws?token=${WS_TOKEN}`;
  let ws: WebSocket | null = null;
  for (let attempt = 0; attempt < 40 && !ws; attempt += 1) {
    ws = await new Promise<WebSocket | null>((resolve) => {
      const sock = new WebSocket(url);
      const to = setTimeout(() => { try { sock.terminate(); } catch { /* */ } resolve(null); }, 500);
      sock.on('open', () => { clearTimeout(to); resolve(sock); });
      sock.on('error', () => { clearTimeout(to); resolve(null); });
    });
    if (!ws) await sleep(500);
  }
  if (!ws) { log('FAIL: ws-server never became reachable'); cleanup(); process.exit(1); }
  const socket = ws;
  log(`connected → ${url}`);

  const received: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.channel === 'symon' || msg.channel === 'system') {
      received.push(msg);
      if (msg.channel === 'symon') log(`◀ ${JSON.stringify(msg)}`);
    }
  });

  const sessionId = `sym-${Math.random().toString(36).slice(2)}`;
  const callId = `call_${Math.random().toString(36).slice(2)}`;
  const sendJson = (m: Record<string, unknown>) => { log(`▶ ${JSON.stringify(m)}`); socket.send(JSON.stringify(m)); };

  await sleep(300);
  sendJson({ type: 'symon-agent-status', channel: 'symon', sessionId, status: 'connecting' });
  await sleep(150);
  sendJson({ type: 'symon-agent-status', channel: 'symon', sessionId, status: 'live' });
  await sleep(150);
  sendJson({ type: 'symon-tool-call', channel: 'symon', sessionId, callId, tool: 'o8_status', args: {} });

  // Wait for the correlated tool-result.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (received.some((m) => m.type === 'symon-tool-result' && m.callId === callId)) break;
    await sleep(100);
  }
  await sleep(200);

  // ── Assertions ──
  const statuses = received.filter((m) => m.type === 'symon-agent-status' && m.sessionId === sessionId);
  const toolResult = received.find((m) => m.type === 'symon-tool-result' && m.callId === callId);
  const sawActing = statuses.some((m) => m.status === 'acting');
  const sawLiveAfterActing =
    statuses.findIndex((m) => m.status === 'acting') >= 0 &&
    statuses.findIndex((m) => m.status === 'live') >
      statuses.findIndex((m) => m.status === 'acting');

  const checks: Array<[string, boolean]> = [
    ['correlated symon-tool-result received (callId matches)', Boolean(toolResult)],
    ['tool-result carries ok + result', Boolean(toolResult && 'ok' in toolResult && 'result' in toolResult)],
    ['acting status emitted while the tool executed', sawActing],
    ['status returned to live after acting', sawLiveAfterActing],
    ['stub tool route was actually invoked', stub.stats.toolCalls >= 1],
  ];

  log('');
  log('── ASSERTIONS ──');
  let ok = true;
  for (const [name, pass] of checks) {
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
  if (toolResult) log(`tool-result payload: ${JSON.stringify(toolResult)}`);

  cleanup();
  await sleep(200);
  log('');
  log(ok ? 'RESULT: PASS (ws-server symon channel verified against a stub tool route)' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-symon-agent-mode crashed:', e);
  process.exit(1);
});
