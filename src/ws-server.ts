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
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { getLiveReviewChangeSet } from './lib/review/live-changes';

// Read repo registry directly (avoid importing registry.ts which uses 'server-only')
function listRepoPathsSync(): string[] {
  try {
    const registryPath = join(homedir(), '.cortex-ide', 'repos.json');
    const raw = readFileSync(registryPath, 'utf-8');
    const store = JSON.parse(raw) as { repos?: Array<{ localPath?: string }> };
    return (store.repos ?? []).map(r => r.localPath).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

// ── node-pty (optional — terminal feature) ──
let pty: typeof import('node-pty') | null = null;
void import('node-pty')
  .then((mod) => {
    pty = mod;
    console.log('[ws-server] node-pty loaded — terminal feature available');
  })
  .catch(() => {
    console.log('[ws-server] node-pty not available — terminal feature disabled');
  });

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
  terminalSessions: Set<string>;
}

// ── Terminal attachment state ──

interface TerminalAttachment {
  id: string;
  sessionName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ptyProcess: any; // node-pty IPty
  clientIds: Set<string>;
  cols: number;
  rows: number;
  batchBuffer: string;
  batchTimer: ReturnType<typeof setTimeout> | null;
}

const terminalAttachments = new Map<string, TerminalAttachment>();
const TERMINAL_BATCH_MS = 16; // batch PTY output every 16ms (60fps)

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

    // ── Terminal commands ──
    case 'terminal-create':
      handleTerminalCreate(client, msg);
      break;
    case 'terminal-attach':
      handleTerminalAttach(client, msg);
      break;
    case 'terminal-input':
      handleTerminalInput(client, msg);
      break;
    case 'terminal-resize':
      handleTerminalResize(client, msg);
      break;
    case 'terminal-detach':
      handleTerminalDetach(client, msg);
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

// ── Terminal handlers ──

/** Find an existing cortex-dash tmux session to reuse, or return null. */
function findExistingDashSession(): string | null {
  try {
    const out = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const sessions = out.trim().split('\n').filter(n => n.startsWith('cortex-dash-'));
    return sessions[0] ?? null;
  } catch {
    return null;
  }
}

// Helper — all terminal events must wrap payload in `data` to match hook parser
function sendTerminal(client: ClientState, event: string, payload: Record<string, unknown>) {
  send(client, { channel: 'terminal', event, data: payload });
}

function handleTerminalCreate(client: ClientState, msg: Record<string, unknown>) {
  if (!pty) {
    sendTerminal(client, 'error', { sessionName: '', error: 'Terminal not available (node-pty not installed)' });
    return;
  }

  const cols = typeof msg.cols === 'number' ? msg.cols : 120;
  const rows = typeof msg.rows === 'number' ? msg.rows : 30;

  // Reuse an existing unattached dashboard tmux session if one exists
  const existing = findExistingDashSession();
  if (existing && !terminalAttachments.has(existing)) {
    console.log(`[ws-server] Reusing existing tmux session: ${existing}`);
    sendTerminal(client, 'created', { sessionName: existing });
    handleTerminalAttach(client, { sessionName: existing, cols, rows });
    return;
  }

  const shortId = randomUUID().slice(0, 8);
  const sessionName = `cortex-dash-${shortId}`;

  try {
    const home = process.env.HOME ?? '/tmp';
    execSync(
      `tmux new-session -d -s ${sessionName} -x ${cols} -y ${rows} -c "${home}" \\; set-option status off \\; set-option default-terminal "xterm-256color" \\; set-option allow-passthrough on \\; set-environment TERM xterm-256color \\; set-environment LANG en_US.UTF-8 \\; set-environment LC_ALL en_US.UTF-8`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    console.log(`[ws-server] Created tmux session: ${sessionName}`);

    sendTerminal(client, 'created', { sessionName });
    handleTerminalAttach(client, { sessionName, cols, rows });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ws-server] Failed to create terminal session:`, error);
    sendTerminal(client, 'error', { sessionName: '', error: `Failed to create terminal: ${error}` });
  }
}

function handleTerminalAttach(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  if (!sessionName || typeof sessionName !== 'string') {
    sendTerminal(client, 'error', { sessionName: '', error: 'sessionName required' });
    return;
  }

  if (!pty) {
    sendTerminal(client, 'error', { sessionName, error: 'Terminal not available (node-pty not installed)' });
    return;
  }

  const cols = typeof msg.cols === 'number' ? msg.cols : 120;
  const rows = typeof msg.rows === 'number' ? msg.rows : 30;

  // Check if we already have a PTY for this tmux session
  let attachment = terminalAttachments.get(sessionName);

  if (attachment) {
    // Add this client to existing attachment
    attachment.clientIds.add(client.id);
    client.terminalSessions.add(sessionName);
    sendTerminal(client, 'attached', { sessionName });
    console.log(`[ws-server] Client ${client.id} attached to existing terminal ${sessionName}`);
    return;
  }

  // Spawn a new PTY that attaches to the tmux session
  try {
    // Spawn via login shell — node-pty's posix_spawnp can fail to find tmux directly
    const shellCmd = `tmux attach-session -t ${sessionName}`;
    console.log(`[ws-server] Spawning terminal: ${shellCmd}`);

    const ptyProcess = pty.spawn('/bin/bash', ['-l', '-c', shellCmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME ?? '/tmp',
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });

    attachment = {
      id: randomUUID(),
      sessionName,
      ptyProcess,
      clientIds: new Set([client.id]),
      cols,
      rows,
      batchBuffer: '',
      batchTimer: null,
    };

    terminalAttachments.set(sessionName, attachment);
    client.terminalSessions.add(sessionName);

    // Wire PTY output → batched WS broadcast
    ptyProcess.onData((data: string) => {
      const att = terminalAttachments.get(sessionName);
      if (!att) return;

      att.batchBuffer += data;

      if (!att.batchTimer) {
        att.batchTimer = setTimeout(() => {
          const buffered = att.batchBuffer;
          att.batchBuffer = '';
          att.batchTimer = null;

          if (!buffered) return;

          const encoded = Buffer.from(buffered, 'utf-8').toString('base64');
          const msg = JSON.stringify({
            channel: 'terminal',
            event: 'data',
            data: { sessionName, data: encoded },
          });

          for (const cid of att.clientIds) {
            const c = clients.get(cid);
            if (c) sendRaw(c, msg);
          }
        }, TERMINAL_BATCH_MS);
      }
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`[ws-server] Terminal PTY exited for ${sessionName} (code ${exitCode})`);
      const att = terminalAttachments.get(sessionName);
      if (!att) return;

      if (att.batchTimer) clearTimeout(att.batchTimer);

      // Flush remaining buffer
      if (att.batchBuffer) {
        const encoded = Buffer.from(att.batchBuffer, 'utf-8').toString('base64');
        const flushMsg = JSON.stringify({
          channel: 'terminal', event: 'data', data: { sessionName, data: encoded },
        });
        for (const cid of att.clientIds) {
          const c = clients.get(cid);
          if (c) sendRaw(c, flushMsg);
        }
      }

      // Notify all clients
      const exitMsg = JSON.stringify({
        channel: 'terminal', event: 'exited', data: { sessionName, exitCode },
      });
      for (const cid of att.clientIds) {
        const c = clients.get(cid);
        if (c) {
          sendRaw(c, exitMsg);
          c.terminalSessions.delete(sessionName);
        }
      }

      terminalAttachments.delete(sessionName);
    });

    sendTerminal(client, 'attached', { sessionName });
    console.log(`[ws-server] Client ${client.id} attached to new terminal ${sessionName}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ws-server] Failed to attach terminal ${sessionName}:`, error);
    sendTerminal(client, 'error', { sessionName, error });
  }
}

function handleTerminalInput(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const data = msg.data as string;
  if (!sessionName || typeof data !== 'string') return;

  const attachment = terminalAttachments.get(sessionName);
  if (!attachment || !attachment.clientIds.has(client.id)) return;

  try {
    attachment.ptyProcess.write(data);
  } catch { /* PTY may have exited */ }
}

function handleTerminalResize(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const cols = msg.cols as number;
  const rows = msg.rows as number;
  if (!sessionName || typeof cols !== 'number' || typeof rows !== 'number') return;

  const attachment = terminalAttachments.get(sessionName);
  if (!attachment) return;

  try {
    attachment.ptyProcess.resize(cols, rows);
    attachment.cols = cols;
    attachment.rows = rows;
  } catch { /* resize may fail if PTY exited */ }
}

function handleTerminalDetach(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  if (!sessionName) return;
  removeClientFromTerminal(client.id, sessionName);
  sendTerminal(client, 'detached', { sessionName });
}

function removeClientFromTerminal(clientId: string, sessionName: string) {
  const attachment = terminalAttachments.get(sessionName);
  if (!attachment) return;

  attachment.clientIds.delete(clientId);
  const c = clients.get(clientId);
  if (c) c.terminalSessions.delete(sessionName);

  // If no more clients, destroy the PTY handle and clean up the tmux session
  if (attachment.clientIds.size === 0) {
    console.log(`[ws-server] No clients left for terminal ${sessionName} — destroying PTY + tmux`);
    if (attachment.batchTimer) clearTimeout(attachment.batchTimer);
    try { attachment.ptyProcess.kill(); } catch { /* already gone */ }
    terminalAttachments.delete(sessionName);

    // Kill dashboard tmux sessions after a grace period (allows reconnection on hot reload).
    // Agent-launched sessions (cortex-codex-*, cortex-claude-*) persist for reattach.
    if (sessionName.startsWith('cortex-dash-')) {
      setTimeout(() => {
        // Only kill if no one reattached during the grace period
        if (terminalAttachments.has(sessionName)) return;
        try {
          execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { timeout: 3000 });
          console.log(`[ws-server] Killed ephemeral tmux session: ${sessionName} (after grace period)`);
        } catch { /* already gone */ }
      }, 10_000);
    }
  }
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
    terminalSessions: new Set(),
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
    // Detach from all terminal sessions
    for (const sessionName of client.terminalSessions) {
      removeClientFromTerminal(client.id, sessionName);
    }
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

// ── Git watcher — push diff stats + file changes on changes ──

const REPO_ROOT = resolve(process.env.CORTEX_IDE_REVIEW_REPO_ROOT || '/Users/marquisehurtt/clawd/repos/cortex-ide');
const GIT_DIR = resolve(REPO_ROOT, '.git');
let lastDiffHash = '';
let diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let reviewPollTimer: ReturnType<typeof setInterval> | null = null;
const reviewTargetHashes = new Map<string, string>();
const REVIEW_POLL_INTERVAL_MS = 10_000;

function shortHome(filePath: string) {
  const home = process.env.HOME ?? '/Users/marquisehurtt';
  return filePath.startsWith(`${home}/`) ? filePath.replace(`${home}/`, '~/') : filePath;
}

async function getReviewWatchTargets() {
  const repoPaths = new Set<string>([REPO_ROOT]);
  for (const p of listRepoPathsSync()) {
    repoPaths.add(resolve(p));
  }

  const targets = [] as Array<{ repoPath: string; workspacePath: string; sessionKey?: string }>;

  for (const repoPath of repoPaths) {
    targets.push({ repoPath, workspacePath: repoPath });

    try {
      const metaPath = resolve(repoPath, '.cortex-worktrees', '.meta.json');
      if (!existsSync(metaPath)) continue;
      const raw = readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as {
        worktrees?: Record<string, { id: string; sessionKey?: string; claudeManaged?: boolean }>;
      };
      for (const worktree of Object.values(meta.worktrees ?? {})) {
        const workspacePath = worktree.claudeManaged
          ? resolve(repoPath, '.claude', 'worktrees', worktree.id)
          : resolve(repoPath, '.cortex-worktrees', worktree.id);
        if (!existsSync(workspacePath)) continue;
        targets.push({
          repoPath,
          workspacePath,
          sessionKey: worktree.sessionKey,
        });
      }
    } catch {
      // Ignore repos without a readable worktree store
    }
  }

  return targets;
}

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

    broadcast({ channel: 'review', event: 'diff-stats', data: { kind: 'diff-stats', additions, deletions, files } });
  });
}

async function broadcastReviewFileChanges() {
  if (clients.size === 0) return;

  const targets = await getReviewWatchTargets();
  const liveTargetKeys = new Set(targets.map((target) => target.workspacePath));

  for (const key of [...reviewTargetHashes.keys()]) {
    if (!liveTargetKeys.has(key)) {
      reviewTargetHashes.delete(key);
    }
  }

  for (const target of targets) {
    try {
      const summary = await getLiveReviewChangeSet(target.workspacePath, target.repoPath, target.sessionKey);
      const hash = JSON.stringify(summary.changedFiles.map((file) => [
        file.path,
        file.status,
        file.additions ?? null,
        file.deletions ?? null,
      ]));

      if (reviewTargetHashes.get(target.workspacePath) === hash) {
        continue;
      }
      reviewTargetHashes.set(target.workspacePath, hash);

      broadcast({
        channel: 'review',
        event: 'file-changes',
        data: {
          kind: 'file-changes',
          repoPath: shortHome(summary.repoPath),
          workspacePath: shortHome(summary.workspacePath),
          sessionKey: summary.sessionKey,
          additions: summary.additions,
          deletions: summary.deletions,
          files: summary.files,
          changedFiles: summary.changedFiles,
        },
      });

      if (resolve(target.workspacePath) === REPO_ROOT) {
        const rootHash = `${summary.additions}:${summary.deletions}:${summary.files}`;
        if (rootHash !== lastDiffHash) {
          lastDiffHash = rootHash;
          broadcast({
            channel: 'review',
            event: 'diff-stats',
            data: {
              kind: 'diff-stats',
              additions: summary.additions,
              deletions: summary.deletions,
              files: summary.files,
            },
          });
        }
      }
    } catch {
      // Ignore transient git failures on disappearing worktrees
    }
  }
}

function scheduleReviewRefresh(delayMs = 500) {
  if (diffDebounceTimer) clearTimeout(diffDebounceTimer);
  diffDebounceTimer = setTimeout(() => {
    void broadcastReviewFileChanges();
    broadcastDiffStats();
  }, delayMs);
}

// Watch .git directory for changes (commits, merges, rebases)
if (existsSync(GIT_DIR)) {
  // Watch refs (branch tips change on commit/push)
  const refsDir = resolve(GIT_DIR, 'refs');
  if (existsSync(refsDir)) {
    watch(refsDir, { recursive: true }, () => {
      scheduleReviewRefresh();
    });
  }
  // Watch index (staged files change)
  const indexFile = resolve(GIT_DIR, 'index');
  if (existsSync(indexFile)) {
    watch(indexFile, () => {
      scheduleReviewRefresh();
    });
  }
  console.log(`[ws-server] Watching git at ${GIT_DIR} for diff changes`);
}

reviewPollTimer = setInterval(() => {
  void broadcastReviewFileChanges();
}, REVIEW_POLL_INTERVAL_MS);
if (reviewPollTimer.unref) reviewPollTimer.unref();

// Don't purge tmux sessions on startup — the reuse logic in handleTerminalCreate
// will find and reattach to existing cortex-dash-* sessions. Purging here races
// with clients that reconnect immediately after a hot reload.

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

  // Destroy all terminal PTY handles (tmux sessions persist independently)
  for (const [, att] of terminalAttachments) {
    if (att.batchTimer) clearTimeout(att.batchTimer);
    try { att.ptyProcess.kill(); } catch { /* already gone */ }
  }
  terminalAttachments.clear();

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
