/**
 * Unified WebSocket server for Cortex IDE mobile.
 *
 * Runs alongside Next.js on port 3002. Multiplexes all real-time data
 * over a single WS connection per mobile client:
 *
 *   Mobile Client ←WS:3002→ This Server ←WS:18789→ OpenClaw Gateway
 *                                        ←HTTP:3001→ Next.js (sync API)
 *
 * Channels:
 *   chat    — streaming text deltas (from gateway WS)
 *   inbox   — session list updates (pushed on change)
 *   history — transcript updates (pushed on change)
 *   review  — review file updates (pushed on change)
 *   pong    — keepalive response
 *
 * The client sends:
 *   { type: "subscribe", sessionKey: "..." }
 *   { type: "switch-session", sessionKey: "..." }
 *   { type: "ping" }
 */

import { readFileSync, watch, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// ── Config ──

const WS_PORT = Number(process.env.WS_PORT ?? 3002);
const NEXT_ORIGIN = process.env.NEXT_ORIGIN ?? 'http://127.0.0.1:3001';
const PING_INTERVAL_MS = 25_000;
const FETCH_TIMEOUT_MS = 8_000;
const BACKPRESSURE_LIMIT = 64 * 1024; // 64KB — skip sends if client buffer exceeds this

interface GatewayConfig {
  port: number;
  token?: string;
}

function loadGatewayConfig(): GatewayConfig {
  const configPath = join(process.env.HOME ?? '/Users/marquisehurtt', '.openclaw', 'openclaw.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return { port: config?.gateway?.port ?? 18789, token: config?.gateway?.auth?.token };
  } catch {
    return { port: 18789 };
  }
}

// ── Types ──

interface ChatDelta {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'done' | 'error' | 'aborted';
  message?: { role: string; content: Array<{ type: string; text?: string }>; timestamp: number };
  partialText?: string;
  error?: string;
}

interface ClientState {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;
  inboxEtag: string | null;
  lastHistoryId: string | null;
  alive: boolean;
}

// ── Gateway connection (singleton) ──

const gatewayConfig = loadGatewayConfig();
let gatewayWs: WebSocket | null = null;
let gatewayConnecting = false;
let gatewayBackoff = 1000;
let gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const gatewayInstanceId = randomUUID();
let gatewayRequestCounter = 0;
const chatListeners = new Set<(delta: ChatDelta) => void>();

function connectGateway() {
  if (gatewayConnecting || gatewayWs?.readyState === WebSocket.OPEN) return;
  gatewayConnecting = true;

  const url = `ws://127.0.0.1:${gatewayConfig.port}`;
  console.log(`[ws-server] Connecting to gateway at ${url}`);

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[ws-server] Gateway WS connected');
    gatewayBackoff = 1000;
  });

  ws.on('message', (raw) => {
    const str = typeof raw === 'string' ? raw : raw.toString();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(str); } catch { return; }

    // Handle connect.challenge
    if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
      const nonce = (parsed.payload as { nonce?: string })?.nonce;
      if (!nonce) { ws.close(); return; }
      ws.send(JSON.stringify({
        type: 'req',
        id: `cortex-ws-${++gatewayRequestCounter}`,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'gateway-client',
            displayName: 'Cortex IDE WS Server',
            version: '0.0.1',
            platform: process.platform,
            mode: 'backend',
            instanceId: gatewayInstanceId,
          },
          caps: [],
          auth: gatewayConfig.token ? { token: gatewayConfig.token } : undefined,
          role: 'operator',
          scopes: ['operator.read'],
        },
      }));
      return;
    }

    // Handle connect response
    if (parsed.type === 'res') {
      if (parsed.ok) {
        console.log('[ws-server] Gateway authenticated');
        gatewayConnecting = false;
      } else {
        console.error('[ws-server] Gateway auth failed:', (parsed.error as { message?: string })?.message);
        ws.close();
      }
      return;
    }

    // Handle chat events
    if (parsed.type === 'event' && parsed.event === 'chat') {
      const delta = parsed.payload as ChatDelta;
      if (delta?.sessionKey) {
        for (const listener of chatListeners) {
          try { listener(delta); } catch { /* ignore */ }
        }
      }
    }

    // Handle session events — push inbox on any session state change
    if (parsed.type === 'event' && (
      parsed.event === 'session.updated' ||
      parsed.event === 'session.created' ||
      parsed.event === 'session.deleted' ||
      parsed.event === 'agent.status'
    )) {
      // Debounce: push inbox to all clients after a short delay
      scheduleEventDrivenInboxPush();
    }
  });

  ws.on('close', () => {
    console.log('[ws-server] Gateway WS closed');
    gatewayWs = null;
    gatewayConnecting = false;
    scheduleGatewayReconnect();
  });

  ws.on('error', (err) => {
    console.error('[ws-server] Gateway WS error:', err.message);
  });

  gatewayWs = ws;
}

function scheduleGatewayReconnect() {
  if (gatewayReconnectTimer) return;
  gatewayReconnectTimer = setTimeout(() => {
    gatewayReconnectTimer = null;
    connectGateway();
  }, gatewayBackoff);
  gatewayBackoff = Math.min(gatewayBackoff * 2, 30_000);
}

// ── Sync helpers ──

async function fetchSync(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${NEXT_ORIGIN}/api/mobile/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractText(delta: ChatDelta): string {
  if (!delta.message?.content) return delta.partialText ?? '';
  return delta.message.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text ?? '')
    .join('');
}

function send(client: ClientState, msg: Record<string, unknown>) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return; // drop if client can't keep up
  client.ws.send(JSON.stringify(msg));
}

function sendRaw(client: ClientState, preStringified: string) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return;
  client.ws.send(preStringified);
}

function broadcast(msg: Record<string, unknown>, filter?: (c: ClientState) => boolean) {
  const json = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (filter && !filter(client)) continue;
    sendRaw(client, json);
  }
}

// ── Client management ──

const clients = new Map<string, ClientState>();

function handleClientMessage(client: ClientState, raw: string) {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {
    case 'subscribe':
    case 'switch-session': {
      const sessionKey = typeof msg.sessionKey === 'string' ? msg.sessionKey : null;
      client.sessionKey = sessionKey;
      client.lastHistoryId = null;
      // Send immediate sync for the new session
      if (sessionKey) {
        void syncClientHistory(client);
      }
      break;
    }
    case 'ping':
      send(client, { channel: 'pong', ts: Date.now() });
      break;
  }
}

async function syncClientInbox(client: ClientState) {
  const data = await fetchSync({ inbox: { etag: client.inboxEtag ?? undefined } });
  if (!data) return;

  if (data.inboxEtag) client.inboxEtag = data.inboxEtag as string;

  if (data.inbox) {
    send(client, { channel: 'inbox', event: 'update', data: data.inbox });
  }
}

async function syncClientHistory(client: ClientState) {
  if (!client.sessionKey) return;

  const body: Record<string, unknown> = {
    history: {
      sessionKey: client.sessionKey,
      sinceId: client.lastHistoryId ?? undefined,
      limit: 18,
    },
  };

  const data = await fetchSync(body);
  if (!data?.history) return;

  const history = data.history as { entries: Array<{ id: string }>; sessionKey: string };
  if (history.entries.length > 0) {
    // Track last seen ID for delta fetching
    client.lastHistoryId = history.entries[history.entries.length - 1].id;
    send(client, { channel: 'history', event: 'update', data: history });
  }
}

// ── Chat delta forwarding ──

function onChatDelta(delta: ChatDelta) {
  const text = extractText(delta);
  const sessionFilter = (c: ClientState) => c.sessionKey === delta.sessionKey;

  if (delta.state === 'delta') {
    broadcast({ channel: 'chat', event: 'delta', data: { text, runId: delta.runId, seq: delta.seq } }, sessionFilter);
  } else if (delta.state === 'done') {
    broadcast({ channel: 'chat', event: 'done', data: { text, runId: delta.runId, seq: delta.seq } }, sessionFilter);
    setTimeout(() => pushHistoryForSession(delta.sessionKey), 500);
    scheduleEventDrivenInboxPush();
  } else if (delta.state === 'error' || delta.state === 'aborted') {
    broadcast({ channel: 'chat', event: 'error', data: { state: delta.state, error: delta.error, runId: delta.runId } }, sessionFilter);
    scheduleEventDrivenInboxPush();
  }
}

chatListeners.add(onChatDelta);

// ── Event-driven push with safety-net polling ──

let inboxPushTimer: ReturnType<typeof setTimeout> | null = null;
const INBOX_PUSH_DEBOUNCE_MS = 300;
const SAFETY_NET_INBOX_MS = 10_000; // 10s safety net (was 3s active poll)
const SAFETY_NET_HISTORY_MS = 8_000; // 8s safety net (was 2s active poll)

function scheduleEventDrivenInboxPush() {
  if (inboxPushTimer) clearTimeout(inboxPushTimer);
  inboxPushTimer = setTimeout(() => {
    inboxPushTimer = null;
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientInbox(c)));
  }, INBOX_PUSH_DEBOUNCE_MS);
}

function pushHistoryForSession(sessionKey: string) {
  const matchingClients = [...clients.values()].filter(
    (c) => c.ws.readyState === WebSocket.OPEN && c.sessionKey === sessionKey,
  );
  if (matchingClients.length === 0) return;
  void Promise.allSettled(matchingClients.map((c) => syncClientHistory(c)));
}

const CONFLICT_SCAN_MS = 5_000; // 5s conflict scan interval

function startPollingLoops() {
  // Safety-net inbox poll — reduced frequency since event-driven push handles most updates
  setInterval(() => {
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientInbox(c)));
  }, SAFETY_NET_INBOX_MS);

  // Safety-net history poll — reduced frequency since chat.done triggers immediate push
  setInterval(() => {
    const activeClients = [...clients.values()].filter(
      (c) => c.ws.readyState === WebSocket.OPEN && c.sessionKey,
    );
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientHistory(c)));
  }, SAFETY_NET_HISTORY_MS);

  // Conflict scan — poll every 5s, push updates to all clients when conflicts change
  // TODO: Track repo per client session for multi-repo support (currently uses process.cwd())
  let lastConflictHash = '';
  setInterval(async () => {
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;

    try {
      const res = await fetch(`${NEXT_ORIGIN}/api/worktrees/conflicts?repo=${encodeURIComponent(process.cwd())}`, {
        headers: {
          'Cache-Control': 'no-cache',
          'Authorization': `Bearer ${WS_TOKEN}`,
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) return;
      const report = await res.json();

      // Only push if conflicts changed (compare hash of file list)
      const hash = JSON.stringify(report.files?.map((f: { file: string; severity: string }) => `${f.file}:${f.severity}`).sort());
      if (hash === lastConflictHash) return;
      lastConflictHash = hash;

      // Push to all clients (pre-stringify once)
      broadcast({ channel: 'conflicts', event: 'update', data: report });
    } catch {
      // Non-critical — conflict scanning is best-effort
    }
  }, CONFLICT_SCAN_MS);
}

// ── Server startup ──

const httpServer = createServer((req, res) => {
  // CORS headers — restrict to localhost + Tauri custom protocol origins
  const allowedOrigins = ['http://localhost:3001', 'http://127.0.0.1:3001', 'tauri://localhost'];
  const origin = req.headers.origin ?? '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clients.size,
      gateway: gatewayWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const WS_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1 }, // fast compression — good enough for JSON
    threshold: 128, // only compress messages > 128 bytes
  },
  verifyClient: (info, done) => {
    const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token');
    if (token !== WS_TOKEN) {
      done(false, 401, 'Unauthorized');
      return;
    }
    done(true);
  },
});

wss.on('connection', (ws) => {
  const client: ClientState = {
    id: randomUUID(),
    ws,
    sessionKey: null,
    inboxEtag: null,
    lastHistoryId: null,
    alive: true,
  };

  clients.set(client.id, client);
  console.log(`[ws-server] Client connected: ${client.id} (${clients.size} total)`);

  // Send welcome with connection info
  send(client, {
    channel: 'system',
    event: 'connected',
    data: {
      clientId: client.id,
      gateway: gatewayWs?.readyState === WebSocket.OPEN ? 'connected' : 'connecting',
    },
  });

  // Send initial inbox
  void syncClientInbox(client);

  ws.on('message', (raw) => {
    handleClientMessage(client, typeof raw === 'string' ? raw : raw.toString());
  });

  ws.on('pong', () => { client.alive = true; });

  ws.on('close', () => {
    clients.delete(client.id);
    console.log(`[ws-server] Client disconnected: ${client.id} (${clients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error(`[ws-server] Client error ${client.id}:`, err.message);
  });
});

// Keepalive ping
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.ws.terminate();
      clients.delete(client.id);
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, PING_INTERVAL_MS);

// ── Git watcher — push diff stats on changes ──

const REPO_ROOT = resolve(process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide');
const GIT_DIR = resolve(REPO_ROOT, '.git');
let lastDiffHash = '';
let diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastDiffStats() {
  if (clients.size === 0) return;

  execFile('sh', ['-c', 'git diff --shortstat origin/main..HEAD 2>/dev/null; git diff --shortstat 2>/dev/null'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 5000,
  }, (err, stdout) => {
    if (err || !stdout) return;
    const stat = stdout.trim();

    let additions = 0, deletions = 0, files = 0;
    for (const line of stat.split('\n').filter(Boolean)) {
      const fm = line.match(/(\d+) files? changed/);
      const am = line.match(/(\d+) insertions?\(\+\)/);
      const dm = line.match(/(\d+) deletions?\(-\)/);
      if (fm) files += parseInt(fm[1]);
      if (am) additions += parseInt(am[1]);
      if (dm) deletions += parseInt(dm[1]);
    }

    const hash = `${additions}:${deletions}:${files}`;
    if (hash === lastDiffHash) return;
    lastDiffHash = hash;

    broadcast({ channel: 'review', event: 'diff-stats', data: { additions, deletions, files } });
  });
}

// Watch .git directory for changes (commits, merges, rebases)
if (existsSync(GIT_DIR)) {
  // Watch refs (branch tips change on commit/push)
  const refsDir = resolve(GIT_DIR, 'refs');
  if (existsSync(refsDir)) {
    watch(refsDir, { recursive: true }, () => {
      if (diffDebounceTimer) clearTimeout(diffDebounceTimer);
      diffDebounceTimer = setTimeout(broadcastDiffStats, 500);
    });
  }
  // Watch index (staged files change)
  const indexFile = resolve(GIT_DIR, 'index');
  if (existsSync(indexFile)) {
    watch(indexFile, () => {
      if (diffDebounceTimer) clearTimeout(diffDebounceTimer);
      diffDebounceTimer = setTimeout(broadcastDiffStats, 500);
    });
  }
  console.log(`[ws-server] Watching git at ${GIT_DIR} for diff changes`);
}

// Start everything
connectGateway();
startPollingLoops();

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[ws-server] Port ${WS_PORT} in use — killing stale process...`);
    try {
      const pids = execSync(`lsof -ti :${WS_PORT} -sTCP:LISTEN`, { encoding: 'utf-8' }).trim();
      if (pids) {
        execSync(`kill -9 ${pids.split('\n').join(' ')}`, { encoding: 'utf-8' });
        console.log(`[ws-server] Killed stale process(es): ${pids.replace(/\n/g, ', ')}`);
        // Retry once after a short delay
        setTimeout(() => {
          httpServer.listen(WS_PORT, '0.0.0.0', () => {
            console.log(`[ws-server] Cortex IDE WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);
          });
        }, 500);
      }
    } catch {
      console.error(`[ws-server] Failed to clear port ${WS_PORT} — exiting`);
      process.exit(1);
    }
  } else {
    throw err;
  }
});

httpServer.listen(WS_PORT, '0.0.0.0', () => {
  console.log(`[ws-server] Cortex IDE WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);
});

// ── Graceful shutdown ──

function shutdown(signal: string) {
  console.log(`[ws-server] ${signal} received — shutting down gracefully`);

  // Close gateway connection
  if (gatewayWs) {
    gatewayWs.close(1001, 'server shutting down');
    gatewayWs = null;
  }

  // Send close frame to every client so they reconnect cleanly
  for (const client of clients.values()) {
    try { client.ws.close(1001, 'server shutting down'); } catch { /* already gone */ }
  }
  clients.clear();

  // Close HTTP + WS server, then exit
  wss.close(() => {
    httpServer.close(() => {
      console.log('[ws-server] Clean shutdown complete');
      process.exit(0);
    });
  });

  // Force exit after 3s if something hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
