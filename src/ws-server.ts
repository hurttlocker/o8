/**
 * Unified WebSocket server for o8 mobile.
 *
 * Runs alongside Next.js on port 3002. Multiplexes all real-time data
 * over a single WS connection per mobile client:
 *
 *   Mobile Client ←WS:3002→ This Server ←HTTP:3001→ Next.js (sync API)
 *
 * Channels:
 *   chat    — streaming text deltas
 *   inbox   — session list updates (pushed on change)
 *   history — transcript updates (pushed on change)
 *   lane-lifecycle — lane status transitions (pushed on change)
 *   review  — review file updates (pushed on change)
 *   pong    — keepalive response
 *
 * The client sends:
 *   { type: "subscribe", sessionKey: "..." }
 *   { type: "switch-session", sessionKey: "..." }
 *   { type: "ping" }
 *
 * Delivery semantics per channel (backpressure behavior):
 *
 *   chat (delta)      — LOSSY: intermediate deltas may be dropped. chat.done
 *                        delivers final text and history safety-net recovers.
 *   chat (done/error) — DURABLE: queued under backpressure and flushed when
 *                        pressure clears (max 32 queued messages per client).
 *   inbox             — DURABLE: queued under backpressure. Also recovered by
 *                        10s safety-net polling.
 *   history           — DURABLE: queued under backpressure. Also recovered by
 *                        8s safety-net polling.
 *   terminal (data)   — LOSSY: inherently best-effort like a real PTY. Frame
 *                        drops are invisible to the user.
 *   terminal (other)  — DURABLE: lifecycle events (created/exited/error) queued.
 *   agent-lifecycle   — DURABLE: queued under backpressure.
 *   lane-lifecycle    — DURABLE: queued under backpressure.
 *   review            — DURABLE: queued under backpressure.
 *   conflicts         — DURABLE: queued under backpressure.
 *   pong              — LOSSY: keepalive response, loss is harmless.
 */

import { readFileSync, watch, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execSync, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import '@/lib/ws-runtime-env';
import { WebSocketServer, WebSocket } from 'ws';
import { getAttachedBrowserSummary, setAttachedBrowserSummary } from './lib/browser/attachment-state';
import { getBrowserInventorySnapshot, getBrowserProvider } from './lib/browser/inventory';
import { getCommandCenterSnapshotWithOptions } from './lib/command-center/snapshot';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from './lib/mobile/types';
import { getLiveReviewChangeSet } from './lib/review/live-changes';
import {
  ensureOrchestratorSession,
  sendToOrchestrator,
  getOrchestratorSession,
  rehydrateOrchestratorSessions,
} from './lib/lane/orchestrator-session';
import {
  startSupervisorLoop,
  stopSupervisorLoop,
  registerWatchedAgent,
  getWatchedAgents,
  type SupervisorCallbacks,
  type AgentUpdateEvent,
} from './lib/supervisor/agent-supervisor';
import {
  runHeadlessSprintTick,
  startHeadlessSprintLoop,
} from '@/lib/orchestrator/headless-loop';
import type {
  LaneLifecycleEventPayload,
  RealtimeBatchMessage,
  RealtimeEventEnvelope,
  RealtimeHealthDescriptor,
  RealtimeInternalRequest,
  RealtimeMutationRecord,
  RealtimeStreamKey,
  RealtimeSubscription,
} from './lib/realtime/types';

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
const BACKPRESSURE_LIMIT = 64 * 1024; // 64KB — queue durable messages if client buffer exceeds this
const BACKPRESSURE_QUEUE_LIMIT = 32; // max queued messages per client before oldest are dropped
const BACKPRESSURE_FLUSH_MS = 50; // check interval to flush queued messages

function normalizeOrchestratorRepoPath(repoPath: string | null): string | null {
  const trimmed = repoPath?.trim();
  if (!trimmed) return null;
  const home = process.env.HOME ?? homedir();
  const expanded = trimmed === '~'
    ? home
    : trimmed.startsWith('~/') && home
      ? join(home, trimmed.slice(2))
      : trimmed;
  return resolve(expanded);
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
  realtimeSubscriptions: RealtimeSubscription[];
  /** Queued durable messages waiting for backpressure to clear */
  backpressureQueue: string[];
  /** Timer that periodically flushes the backpressure queue */
  flushTimer: ReturnType<typeof setInterval> | null;
}

const EMPTY_MOBILE_INBOX: MobileInboxSnapshot = {
  generatedAt: '',
  mode: 'live',
  sourceLabel: 'Local runtime websocket bridge',
  note: 'Live runtime updates come from the local Codex and Claude Code inventory.',
  sessions: [],
  approvals: [],
  items: [],
  summary: {
    alerts: 0,
    approvals: 0,
    reviewItems: 0,
    activeRuns: 0,
  },
};

async function getMobileInboxSnapshot(_options: { fresh?: boolean } = {}) {
  void _options;
  return EMPTY_MOBILE_INBOX;
}

async function getSessionTranscript(_sessionKey: string, _limit: number, _fresh: boolean) {
  void _sessionKey;
  void _limit;
  void _fresh;
  return [] as MobileTranscriptEntry[];
}

// ── Terminal attachment state ──

interface TerminalAttachment {
  id: string;
  sessionName: string;
  kind: 'dash-shell' | 'tmux-attach' | 'managed-process';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ptyProcess: any; // node-pty IPty
  clientIds: Set<string>;
  cols: number;
  rows: number;
  batchBuffer: string;
  batchTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number; // timestamp of last PTY output (for stall detection)
  createdAt: number;    // timestamp of terminal creation
  orphanTimer: ReturnType<typeof setTimeout> | null;
  scrollbackChunks: string[];
  scrollbackBytes: number;
}

interface InternalTerminalSpawnPayload {
  sessionName?: string;
  shellCommand?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

interface InternalTerminalSignalPayload {
  sessionName?: string;
  signal?: string;
}

const terminalAttachments = new Map<string, TerminalAttachment>();
const TERMINAL_BATCH_MS = 16; // batch PTY output every 16ms (60fps)
const DASH_SESSION_ORPHAN_TTL_MS = 30 * 60 * 1000;
const TERMINAL_SCROLLBACK_MAX_BYTES = 512 * 1024;

// ── Orchestrator channel state ──

interface OrchestratorSubscription {
  clientId: string;
  repoPath: string;
  sessionName: string;
}

const orchestratorSubscriptions = new Map<string, OrchestratorSubscription>(); // clientId → subscription

// ── Agent Supervisor auto-message queue ──

interface OrchestratorAutoMessage {
  repoPath: string;
  message: string;
  createdAt: number;
}

const orchestratorAutoQueue: OrchestratorAutoMessage[] = [];
const MAX_AUTO_QUEUE = 20;

function queueOrchestratorEscalation(repoPath: string, message: string): void {
  if (orchestratorAutoQueue.length >= MAX_AUTO_QUEUE) {
    orchestratorAutoQueue.shift(); // Drop oldest
    console.warn('[supervisor] Auto-message queue overflow — dropped oldest');
  }
  orchestratorAutoQueue.push({ repoPath, message, createdAt: Date.now() });
  console.log(`[supervisor] Queued escalation for ${repoPath} (${orchestratorAutoQueue.length} in queue)`);
  void drainOrchestratorAutoQueue();
}

async function drainOrchestratorAutoQueue(): Promise<void> {
  if (orchestratorAutoQueue.length === 0) return;

  const next = orchestratorAutoQueue[0];
  let session = getOrchestratorSession(next.repoPath);
  if (!session || session.status === 'dead') {
    session = ensureOrchestratorSession(next.repoPath);
  }
  if (session.status === 'busy') return; // Wait for current message to finish

  // Dequeue
  orchestratorAutoQueue.shift();
  console.log(`[supervisor] Draining auto-message for ${next.repoPath}`);

  try {
    await sendToOrchestrator(session, next.message, (event) => {
      // Broadcast to all subscribed WS clients (same as handleOrchestratorSendMsg)
      const subscribedClients: string[] = [];
      for (const [cid, sub] of orchestratorSubscriptions) {
        if (sub.sessionName === session!.sessionName) subscribedClients.push(cid);
      }
      if (subscribedClients.length === 0) return;

      let wsMsg: string | null = null;
      switch (event.type) {
        case 'text':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'output', data: { text: event.text, repoPath: next.repoPath, thinking: false } });
          break;
        case 'thinking':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'output', data: { text: event.text, repoPath: next.repoPath, thinking: true } });
          break;
        case 'tool_use':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'tool-use', data: { name: event.name, repoPath: next.repoPath } });
          break;
        case 'done':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'status', data: { status: 'ready', repoPath: next.repoPath } });
          break;
        case 'error':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'error', data: { error: event.error, repoPath: next.repoPath } });
          break;
      }
      if (wsMsg) {
        for (const cid of subscribedClients) {
          const c = clients.get(cid);
          if (c) sendRaw(c, wsMsg);
        }
      }
    });
  } catch (err) {
    console.error('[supervisor] Auto-message failed:', err);
  }

  // Continue draining
  void drainOrchestratorAutoQueue();
}

// Orchestrator now uses structured JSON output (stream-json) instead of PTY.
// See orchestrator-session.ts for the new approach.

function sanitizePtyEnv() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env.TERM = 'xterm-256color';
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_ALL = env.LC_ALL || 'en_US.UTF-8';
  env.PATH = env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

function resolvePreferredShell() {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return '/bin/sh';
}

function resolveTmuxBinary() {
  const candidates = [
    process.env.TMUX_BIN,
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux',
    '/bin/tmux',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  try {
    return execSync('command -v tmux', {
      encoding: 'utf-8',
      timeout: 3000,
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    }).trim() || 'tmux';
  } catch {
    return 'tmux';
  }
}

function isDashTerminalSession(sessionName: string) {
  return sessionName.startsWith('cortex-dash-');
}

function spawnDashShellPty(
  sessionName: string,
  cols: number,
  rows: number,
) {
  if (!pty) {
    throw new Error('node-pty not available');
  }

  const shell = resolvePreferredShell();
  const env = sanitizePtyEnv();
  env.CORTEX_TERMINAL_SESSION_NAME = sessionName;
  const cwd = process.env.HOME ?? homedir() ?? '/tmp';

  console.log(`[ws-server] Spawning dashboard PTY shell: ${shell} -l (${sessionName})`);
  return pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
}

function spawnManagedCommandPty(
  sessionName: string,
  shellCommand: string,
  cwd: string,
  cols: number,
  rows: number,
  envOverrides?: Record<string, string>,
) {
  if (!pty) {
    throw new Error('node-pty not available');
  }

  const shell = resolvePreferredShell();
  const env = {
    ...sanitizePtyEnv(),
    ...(envOverrides ?? {}),
    CORTEX_TERMINAL_SESSION_NAME: sessionName,
  };

  console.log(`[ws-server] Spawning managed PTY session: ${shell} -lc <command> (${sessionName})`);
  return pty.spawn(shell, ['-l', '-c', shellCommand], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
}

function trimScrollback(att: TerminalAttachment) {
  while (att.scrollbackBytes > TERMINAL_SCROLLBACK_MAX_BYTES && att.scrollbackChunks.length > 0) {
    const removed = att.scrollbackChunks.shift() ?? '';
    att.scrollbackBytes -= Buffer.byteLength(removed, 'utf-8');
  }
}

function appendScrollback(att: TerminalAttachment, data: string) {
  if (!data) return;
  att.scrollbackChunks.push(data);
  att.scrollbackBytes += Buffer.byteLength(data, 'utf-8');
  trimScrollback(att);
}

function sendTerminalScrollback(client: ClientState, attachment: TerminalAttachment) {
  if (attachment.scrollbackChunks.length === 0) return;
  const scrollback = attachment.scrollbackChunks.join('');
  if (!scrollback) return;
  const encoded = Buffer.from(scrollback, 'utf-8').toString('base64');
  sendRaw(client, JSON.stringify({
    channel: 'terminal',
    event: 'data',
    data: { sessionName: attachment.sessionName, data: encoded },
  }));
}

function registerTerminalAttachment(attachment: TerminalAttachment) {
  const { sessionName, ptyProcess } = attachment;

  ptyProcess.onData((data: string) => {
    const att = terminalAttachments.get(sessionName);
    if (!att) return;

    att.lastOutputAt = Date.now();
    appendScrollback(att, data);
    att.batchBuffer += data;

    if (!att.batchTimer) {
      att.batchTimer = setTimeout(() => {
        const buffered = att.batchBuffer;
        att.batchBuffer = '';
        att.batchTimer = null;

        if (!buffered || att.clientIds.size === 0) return;

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
    if (att.orphanTimer) clearTimeout(att.orphanTimer);

    if (att.batchBuffer) {
      appendScrollback(att, att.batchBuffer);
      const encoded = Buffer.from(att.batchBuffer, 'utf-8').toString('base64');
      const flushMsg = JSON.stringify({
        channel: 'terminal', event: 'data', data: { sessionName, data: encoded },
      });
      for (const cid of att.clientIds) {
        const c = clients.get(cid);
        if (c) sendRaw(c, flushMsg);
      }
    }

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

    if (!isDashTerminalSession(sessionName)) {
      broadcastLifecycle(sessionName, exitCode === 0 ? 'completed' : 'failed', exitCode);
    }
  });
}

function spawnTmuxAttachPty(
  sessionName: string,
  cols: number,
  rows: number,
) {
  if (!pty) {
    throw new Error('node-pty not available');
  }

  const tmuxBin = resolveTmuxBinary();
  const env = sanitizePtyEnv();
  const cwd = process.env.HOME ?? homedir() ?? '/tmp';

  try {
    console.log(`[ws-server] Spawning terminal directly: ${tmuxBin} attach-session -t ${sessionName}`);
    return pty.spawn(tmuxBin, ['attach-session', '-t', sessionName], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  } catch (directError) {
    const shell = resolvePreferredShell();
    const shellCmd = `exec "${tmuxBin}" attach-session -t ${sessionName}`;
    console.warn(`[ws-server] Direct tmux PTY spawn failed, falling back to shell wrapper: ${directError instanceof Error ? directError.message : String(directError)}`);
    console.log(`[ws-server] Spawning terminal via shell: ${shellCmd}`);
    return pty.spawn(shell, ['-l', '-c', shellCmd], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  }
}

const chatListeners = new Set<(delta: ChatDelta) => void>();

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

/**
 * Determine whether a message is "lossy" (safe to drop under backpressure)
 * or "durable" (must be queued and flushed later).
 *
 * Lossy channels: chat deltas, terminal data, pong — all are either
 * inherently lossy or recovered by higher-level mechanisms.
 */
function isLossyMessage(json: string): boolean {
  // Fast path: avoid parsing — check for known lossy patterns
  if (json.includes('"channel":"pong"')) return true;
  // Chat deltas (not done/error) are lossy
  if (json.includes('"channel":"chat"') && json.includes('"event":"delta"')) return true;
  // Terminal data frames are lossy (PTY output is best-effort)
  if (json.includes('"channel":"terminal"') && json.includes('"event":"data"')) return true;
  // Orchestrator output chunks are lossy (intermediate deltas can be dropped)
  if (json.includes('"channel":"orchestrator"') && json.includes('"event":"output"')) return true;
  return false;
}

/** Flush any queued durable messages once backpressure clears. */
function flushBackpressureQueue(client: ClientState) {
  if (client.ws.readyState !== WebSocket.OPEN) {
    client.backpressureQueue.length = 0;
    stopFlushTimer(client);
    return;
  }
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return; // still pressured

  // Drain the queue
  while (client.backpressureQueue.length > 0) {
    if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return; // pause mid-flush
    const queued = client.backpressureQueue.shift()!;
    client.ws.send(queued);
  }
  stopFlushTimer(client);
}

function startFlushTimer(client: ClientState) {
  if (client.flushTimer) return;
  client.flushTimer = setInterval(() => flushBackpressureQueue(client), BACKPRESSURE_FLUSH_MS);
}

function stopFlushTimer(client: ClientState) {
  if (client.flushTimer) {
    clearInterval(client.flushTimer);
    client.flushTimer = null;
  }
}

function send(client: ClientState, msg: Record<string, unknown>) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  const json = JSON.stringify(msg);
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) {
    if (isLossyMessage(json)) return; // safe to drop
    // Queue durable message for later delivery
    if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
      client.backpressureQueue.shift(); // drop oldest if queue is full
    }
    client.backpressureQueue.push(json);
    startFlushTimer(client);
    return;
  }
  // Flush any pending queue first (maintain ordering)
  if (client.backpressureQueue.length > 0) {
    flushBackpressureQueue(client);
  }
  client.ws.send(json);
}

function sendRaw(client: ClientState, preStringified: string) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) {
    if (isLossyMessage(preStringified)) return; // safe to drop
    if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
      client.backpressureQueue.shift();
    }
    client.backpressureQueue.push(preStringified);
    startFlushTimer(client);
    return;
  }
  if (client.backpressureQueue.length > 0) {
    flushBackpressureQueue(client);
  }
  client.ws.send(preStringified);
}

function broadcast(msg: Record<string, unknown>, filter?: (c: ClientState) => boolean) {
  const json = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (filter && !filter(client)) continue;
    sendRaw(client, json);
  }
}

// ── Realtime envelope log / replay ──

const REALTIME_LOG_LIMIT = 400;
const BROWSER_DISCOVERY_INTERVAL_MS = 15_000;
const ATTACHED_BROWSER_REFRESH_MS = 2_000;

let realtimeSeq = 0;
const realtimeLog: RealtimeEventEnvelope[] = [];
let runtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeRefreshFreshRequested = false;
let mobileRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let mobileRefreshFreshRequested = false;
const sessionHistoryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let browserDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let attachedBrowserRefreshTimer: ReturnType<typeof setInterval> | null = null;
let stopHeadlessLoop: (() => void) | null = null;

const lastRealtimeFingerprint = {
  runtime: '',
  review: '',
  browser: '',
  mobileInbox: '',
  history: new Map<string, string>(),
};

function currentIsoTime() {
  return new Date().toISOString();
}

function mutationToLaneLifecyclePayload(
  mutation: RealtimeMutationRecord,
): LaneLifecycleEventPayload | null {
  if (mutation.action !== 'lane-lifecycle') return null;
  if (!mutation.laneId || !mutation.laneStatus || !mutation.branch || !mutation.repoPath || !mutation.timestamp) {
    return null;
  }

  return {
    laneId: mutation.laneId,
    packetId: mutation.packetId ?? null,
    status: mutation.laneStatus,
    previousStatus: mutation.previousStatus ?? null,
    sessionKey: mutation.sessionKey ?? null,
    branch: mutation.branch,
    repoPath: mutation.repoPath,
    timestamp: mutation.timestamp,
  };
}

function clampRealtimeLog() {
  if (realtimeLog.length <= REALTIME_LOG_LIMIT) return;
  realtimeLog.splice(0, realtimeLog.length - REALTIME_LOG_LIMIT);
}

function normalizeRealtimeStreamKey(raw: string | undefined, sessionKey?: string | null): RealtimeStreamKey | null {
  if (!raw) return null;
  if (raw === 'global') return 'global';
  if (raw === 'session' || raw === 'session:*') {
    return sessionKey ? `session:${sessionKey}` : null;
  }
  if (raw.startsWith('session:')) return raw as RealtimeStreamKey;
  return null;
}

function eventMatchesRealtimeSubscription(
  envelope: RealtimeEventEnvelope,
  subscription: RealtimeSubscription,
) {
  return envelope.stream === subscription.stream;
}

function sendRealtimeBatch(
  client: ClientState,
  stream: RealtimeStreamKey,
  delivery: RealtimeBatchMessage['delivery'],
  events: RealtimeEventEnvelope[],
  gap?: RealtimeBatchMessage['gap'],
) {
  if (!events.length) return;
  send(client, {
    channel: 'realtime',
    event: 'batch',
    data: {
      delivery,
      stream,
      events,
      latestSeq: events[events.length - 1]?.seq ?? realtimeSeq,
      gap,
    } satisfies RealtimeBatchMessage,
  });
}

function buildRealtimeEnvelope(
  stream: RealtimeStreamKey,
  channel: RealtimeEventEnvelope['channel'],
  event: RealtimeEventEnvelope['event'],
  data: RealtimeEventEnvelope['data'],
  options: {
    snapshot?: boolean;
    health?: RealtimeHealthDescriptor;
    entityId?: string;
    delivery?: RealtimeEventEnvelope['delivery'];
    capturedSeq?: number;
  } = {},
): RealtimeEventEnvelope {
  const envelope: RealtimeEventEnvelope = {
    protocol: 1,
    seq: ++realtimeSeq,
    capturedSeq: options.capturedSeq,
    stream,
    channel,
    event,
    ts: currentIsoTime(),
    snapshot: options.snapshot,
    delivery: options.delivery,
    entityId: options.entityId,
    health: options.health,
    data,
  };

  if (options.delivery !== 'bootstrap') {
    realtimeLog.push(envelope);
    clampRealtimeLog();
  }

  return envelope;
}

function broadcastRealtimeEvents(events: RealtimeEventEnvelope[]) {
  if (!events.length) return;
  const eventsByStream = new Map<RealtimeStreamKey, RealtimeEventEnvelope[]>();

  for (const event of events) {
    const bucket = eventsByStream.get(event.stream);
    if (bucket) {
      bucket.push(event);
    } else {
      eventsByStream.set(event.stream, [event]);
    }
  }

  for (const client of clients.values()) {
    for (const subscription of client.realtimeSubscriptions) {
      const matching = eventsByStream.get(subscription.stream);
      if (!matching?.length) continue;
      sendRealtimeBatch(client, subscription.stream, 'live', matching);
    }
  }
}

function retainedEventsForStream(stream: RealtimeStreamKey) {
  return realtimeLog.filter((event) => event.stream === stream);
}

function earliestRetainedSeq(stream: RealtimeStreamKey) {
  return retainedEventsForStream(stream)[0]?.seq;
}

function replayRealtimeSubscriptions(client: ClientState, subscriptions: RealtimeSubscription[]) {
  client.realtimeSubscriptions = subscriptions;

  for (const subscription of subscriptions) {
    const stream = subscription.stream;
    const since = subscription.since ?? 0;
    const earliestAvailable = earliestRetainedSeq(stream);
    if (since > 0 && (earliestAvailable == null || since < (earliestAvailable - 1))) {
      void buildResyncEvents(stream).then((events) => {
        sendRealtimeBatch(client, stream, 'bootstrap', events, {
          requestedSince: since,
          earliestAvailable: earliestAvailable ?? (realtimeSeq + 1),
        });
      });
      continue;
    }
    const replay = realtimeLog.filter((event) => (
      event.seq > since && eventMatchesRealtimeSubscription(event, subscription)
    ));
    if (replay.length > 0) {
      sendRealtimeBatch(client, stream, 'replay', replay);
    }
  }
}

async function buildResyncEvents(stream: RealtimeStreamKey) {
  const capturedSeq = realtimeSeq;
  if (stream === 'global') {
    try {
      const snapshot = await getCommandCenterSnapshotWithOptions({ fresh: true });
      const degradedHealth: RealtimeHealthDescriptor = {
        state: 'degraded',
        reason: 'Replay gap detected; forcing fresh global resync.',
      };
      const events: RealtimeEventEnvelope[] = [
        buildRealtimeEnvelope(
          'global',
          'runtime',
          'runtime.snapshot',
          { fleet: snapshot.fleet },
          { snapshot: true, entityId: 'fleet', health: degradedHealth, capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'review',
          'review.snapshot',
          { review: snapshot.review, error: snapshot.reviewError ?? null },
          { snapshot: true, entityId: 'workflow-review', health: degradedHealth, capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory: snapshot.browserInventory,
            attachedBrowser: snapshot.attachedBrowser,
            error: snapshot.browserError ?? null,
          },
          { snapshot: true, entityId: 'browser-inventory', health: degradedHealth, capturedSeq },
        ),
      ];

      const inbox = await getMobileInboxSnapshot({ fresh: true }).catch(() => null);
      if (inbox) {
        events.push(buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox },
          { snapshot: true, entityId: 'mobile-inbox', health: degradedHealth, capturedSeq },
        ));
      }

      return events;
    } catch {
      return [] as RealtimeEventEnvelope[];
    }
  }

  if (!stream.startsWith('session:')) return [] as RealtimeEventEnvelope[];
  const sessionKey = stream.slice('session:'.length);
  if (!sessionKey) return [] as RealtimeEventEnvelope[];

  try {
    const entries = await getSessionTranscript(sessionKey, 24, true);
    return [
      buildRealtimeEnvelope(
        stream,
        'history',
        'history.snapshot',
        { sessionKey, entries, replace: true },
        {
          snapshot: true,
          entityId: sessionKey,
          capturedSeq,
          health: {
            state: 'degraded',
            reason: 'Replay gap detected; forcing fresh session resync.',
          },
        },
      ),
    ];
  } catch {
    return [] as RealtimeEventEnvelope[];
  }
}

async function buildBootstrapEvents(stream: RealtimeStreamKey) {
  const capturedSeq = realtimeSeq;
  if (stream === 'global') {
    try {
      const snapshot = await getCommandCenterSnapshotWithOptions({ fresh: false });
      const runtimeHealth = deriveRuntimeHealth(snapshot.fleet);
      const events: RealtimeEventEnvelope[] = [
        buildRealtimeEnvelope(
          'global',
          'runtime',
          'runtime.snapshot',
          { fleet: snapshot.fleet },
          { snapshot: true, entityId: 'fleet', health: runtimeHealth, delivery: 'bootstrap', capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'review',
          'review.snapshot',
          { review: snapshot.review, error: snapshot.reviewError ?? null },
          {
            snapshot: true,
            entityId: 'workflow-review',
            health: snapshot.reviewError ? { state: 'stale', reason: snapshot.reviewError } : runtimeHealth,
            delivery: 'bootstrap',
            capturedSeq,
          },
        ),
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory: snapshot.browserInventory,
            attachedBrowser: snapshot.attachedBrowser,
            error: snapshot.browserError ?? null,
          },
          {
            snapshot: true,
            entityId: 'browser-inventory',
            health: snapshot.browserError ? { state: 'stale', reason: snapshot.browserError } : runtimeHealth,
            delivery: 'bootstrap',
            capturedSeq,
          },
        ),
      ];

      const inbox = await getMobileInboxSnapshot().catch(() => null);
      if (inbox) {
        events.push(buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox },
          {
            snapshot: true,
            entityId: 'mobile-inbox',
            health: inbox.mode === 'live' ? { state: 'live' } : { state: 'degraded', reason: inbox.note },
            delivery: 'bootstrap',
            capturedSeq,
          },
        ));
      }

      return events;
    } catch {
      return [] as RealtimeEventEnvelope[];
    }
  }

  if (!stream.startsWith('session:')) return [] as RealtimeEventEnvelope[];
  const sessionKey = stream.slice('session:'.length);
  if (!sessionKey) return [] as RealtimeEventEnvelope[];

  try {
    const entries = await getSessionTranscript(sessionKey, 24, false);
    return [
      buildRealtimeEnvelope(
        stream,
        'history',
        'history.snapshot',
        { sessionKey, entries, replace: true },
        {
          snapshot: true,
          entityId: sessionKey,
          health: { state: 'live' },
          delivery: 'bootstrap',
          capturedSeq,
        },
      ),
    ];
  } catch {
    return [] as RealtimeEventEnvelope[];
  }
}

function fingerprintRuntimeSnapshot(fleet: Awaited<ReturnType<typeof getCommandCenterSnapshotWithOptions>>['fleet']) {
  // Lightweight string concat instead of JSON.stringify on nested objects.
  // Same change-detection semantics — all discriminating fields are represented.
  const m = fleet.meta;
  let fp = `${m.mode}\x01${m.gatewayFreshness ?? ''}\x01${m.observablePending ? 1 : 0}\x01${m.primarySessionKey ?? ''}`;
  for (const a of fleet.agents) {
    fp += `\x02${a.id}\x01${a.status}\x01${a.currentTask}\x01${a.approvalStatus}\x01${a.lastEventAt}\x01${Math.round(a.context.usedPercent ?? 0)}\x01${a.alerts}\x01${a.runtimeSurface?.lifecycle?.availability ?? ''}\x01${a.runtimeSurface?.lifecycle?.lastOutcome ?? ''}\x01${a.activity?.headline ?? ''}\x01${a.browserSurface?.lastAction ?? ''}`;
  }
  return fp;
}

function fingerprintReviewSnapshot(review: Awaited<ReturnType<typeof getCommandCenterSnapshotWithOptions>>['review']) {
  if (!review) return 'no-review';
  let fp = `${review.repoSlug}\x01${review.branch}\x01${review.dirty ? 1 : 0}\x01${review.diffStat}`;
  for (const issue of review.activeIssues) fp += `\x02i${issue.number}`;
  for (const pr of review.pullRequests) fp += `\x02p${pr.number}`;
  for (const f of review.changedFiles) fp += `\x02${f.path}\x01${f.status}\x01${f.additions ?? 0}\x01${f.deletions ?? 0}`;
  return fp;
}

function fingerprintBrowserSnapshot(
  browserInventory: Awaited<ReturnType<typeof getCommandCenterSnapshotWithOptions>>['browserInventory'],
  attachedBrowser: ReturnType<typeof getAttachedBrowserSummary>,
) {
  let fp = '';
  for (const s of browserInventory.surfaces) {
    fp += `\x02${s.id}\x01${s.provider}\x01${s.status}\x01${s.url}\x01${s.title}\x01${s.lastAction}\x01${s.lastActionAt ?? 0}`;
  }
  if (attachedBrowser) {
    fp += `\x03${attachedBrowser.provider}\x01${attachedBrowser.surface.id}\x01${attachedBrowser.attachedAt}`;
    for (const page of attachedBrowser.pages) fp += `\x02${page.id}\x01${page.title ?? page.url ?? ''}`;
  }
  return fp;
}

function fingerprintInboxSnapshot(inbox: Awaited<ReturnType<typeof getMobileInboxSnapshot>>) {
  // Encode inbox.summary as a flat key-value string (it's a small typed object).
  const sum = inbox.summary;
  let fp = `${sum.activeRuns}\x01${sum.approvals}\x01${sum.alerts}\x01${sum.reviewItems}`;
  for (const s of inbox.sessions) {
    fp += `\x02${s.id}\x01${s.sessionKey}\x01${s.status}\x01${s.currentTask}\x01${s.approvalStatus}\x01${s.lastEventAt}\x01${s.branch}\x01${s.alerts}`;
  }
  for (const item of inbox.items) {
    fp += `\x03${item.id}\x01${item.kind}\x01${item.severity}\x01${item.detail}\x01${item.title}\x01${item.sessionKey}`;
  }
  if (inbox.review) {
    const r = inbox.review;
    fp += `\x04${r.repoSlug}\x01${r.branch}\x01${r.diffStat}`;
    for (const f of r.changedFiles) fp += `\x02${f.path}\x01${f.status}`;
  }
  return fp;
}

function fingerprintHistory(sessionKey: string, entries: Awaited<ReturnType<typeof getSessionTranscript>>) {
  let fp = sessionKey;
  for (const e of entries) fp += `\x02${e.id}\x01${e.timestamp ?? 0}\x01${e.role}\x01${e.text.slice(0, 80)}`;
  return fp;
}

function deriveRuntimeHealth(fleet: Awaited<ReturnType<typeof getCommandCenterSnapshotWithOptions>>['fleet']): RealtimeHealthDescriptor {
  if (fleet.meta.mode !== 'live') {
    return { state: 'degraded', reason: fleet.meta.note ?? 'demo fallback' };
  }
  if (fleet.meta.gatewayFreshness === 'stale') {
    return { state: 'stale', reason: fleet.meta.gatewayLabel ?? 'gateway status is stale' };
  }
  if (fleet.meta.gatewayFreshness === 'warming' || fleet.meta.observablePending) {
    return { state: 'warming', reason: fleet.meta.gatewayLabel ?? 'runtime state is warming' };
  }
  return { state: 'live' };
}

async function publishGlobalRealtimeSnapshot(options: { fresh?: boolean; reason?: string } = {}) {
  try {
    const snapshot = await getCommandCenterSnapshotWithOptions({ fresh: options.fresh });
    const runtimeHealth = deriveRuntimeHealth(snapshot.fleet);
    const events: RealtimeEventEnvelope[] = [];

    const runtimeFingerprint = fingerprintRuntimeSnapshot(snapshot.fleet);
    if (runtimeFingerprint !== lastRealtimeFingerprint.runtime) {
      lastRealtimeFingerprint.runtime = runtimeFingerprint;
      events.push(buildRealtimeEnvelope(
        'global',
        'runtime',
        'runtime.snapshot',
        { fleet: snapshot.fleet },
        { snapshot: true, entityId: 'fleet', health: runtimeHealth },
      ));
    }

    const reviewFingerprint = fingerprintReviewSnapshot(snapshot.review);
    if (reviewFingerprint !== lastRealtimeFingerprint.review || options.fresh) {
      lastRealtimeFingerprint.review = reviewFingerprint;
      events.push(buildRealtimeEnvelope(
        'global',
        'review',
        'review.snapshot',
        { review: snapshot.review, error: snapshot.reviewError ?? null },
        {
          snapshot: true,
          entityId: 'workflow-review',
          health: snapshot.reviewError ? { state: 'stale', reason: snapshot.reviewError } : runtimeHealth,
        },
      ));
    }

    const browserFingerprint = fingerprintBrowserSnapshot(snapshot.browserInventory, snapshot.attachedBrowser);
    if (browserFingerprint !== lastRealtimeFingerprint.browser || options.fresh) {
      lastRealtimeFingerprint.browser = browserFingerprint;
      events.push(buildRealtimeEnvelope(
        'global',
        'browser',
        'browser.snapshot',
        {
          browserInventory: snapshot.browserInventory,
          attachedBrowser: snapshot.attachedBrowser,
          error: snapshot.browserError ?? null,
        },
        {
          snapshot: true,
          entityId: 'browser-inventory',
          health: snapshot.browserError ? { state: 'stale', reason: snapshot.browserError } : runtimeHealth,
        },
      ));
    }

    broadcastRealtimeEvents(events);
  } catch (error) {
    console.error('[ws-server] realtime global snapshot failed:', error instanceof Error ? error.message : 'unknown');
  }
}

async function publishMobileInboxRealtimeSnapshot(fresh = false) {
  try {
    const inbox = await getMobileInboxSnapshot({ fresh });
    const fingerprint = fingerprintInboxSnapshot(inbox);
    if (fingerprint === lastRealtimeFingerprint.mobileInbox) return;
    lastRealtimeFingerprint.mobileInbox = fingerprint;

    broadcastRealtimeEvents([
      buildRealtimeEnvelope(
        'global',
        'mobile',
        'mobile.inbox.snapshot',
        { inbox },
        {
          snapshot: true,
          entityId: 'mobile-inbox',
          health: inbox.mode === 'live' ? { state: 'live' } : { state: 'degraded', reason: inbox.note },
        },
      ),
    ]);
  } catch (error) {
    console.error('[ws-server] realtime mobile inbox snapshot failed:', error instanceof Error ? error.message : 'unknown');
  }
}

async function publishSessionHistoryRealtimeSnapshot(sessionKey: string, fresh = false) {
  if (!sessionKey) return;
  try {
    const entries = await getSessionTranscript(sessionKey, 24, fresh);
    const fingerprint = fingerprintHistory(sessionKey, entries);
    if (!fresh && lastRealtimeFingerprint.history.get(sessionKey) === fingerprint) return;
    lastRealtimeFingerprint.history.set(sessionKey, fingerprint);

    broadcastRealtimeEvents([
      buildRealtimeEnvelope(
        `session:${sessionKey}`,
        'history',
        'history.snapshot',
        { sessionKey, entries },
        {
          snapshot: true,
          entityId: sessionKey,
          health: { state: 'live' },
        },
      ),
    ]);
  } catch (error) {
    console.error('[ws-server] realtime session history failed:', error instanceof Error ? error.message : 'unknown');
  }
}

function scheduleRealtimeRuntimeRefresh(options: { fresh?: boolean; reason?: string } = {}) {
  runtimeRefreshFreshRequested = runtimeRefreshFreshRequested || Boolean(options.fresh);
  if (runtimeRefreshTimer) return;
  runtimeRefreshTimer = setTimeout(() => {
    const fresh = runtimeRefreshFreshRequested;
    runtimeRefreshFreshRequested = false;
    runtimeRefreshTimer = null;
    void publishGlobalRealtimeSnapshot({ fresh, reason: options.reason });
  }, options.fresh ? 50 : 250);
}

function scheduleRealtimeMobileInboxRefresh(delayMs = 250, fresh = false) {
  if (mobileRefreshTimer) {
    mobileRefreshFreshRequested = mobileRefreshFreshRequested || fresh;
    return;
  }
  mobileRefreshFreshRequested = mobileRefreshFreshRequested || fresh;
  mobileRefreshTimer = setTimeout(() => {
    const nextFresh = mobileRefreshFreshRequested;
    mobileRefreshFreshRequested = false;
    mobileRefreshTimer = null;
    void publishMobileInboxRealtimeSnapshot(nextFresh);
  }, delayMs);
}

function scheduleRealtimeSessionHistoryRefresh(sessionKey: string, fresh = false, delayMs = 350) {
  const existing = sessionHistoryTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    sessionHistoryTimers.delete(sessionKey);
    void publishSessionHistoryRealtimeSnapshot(sessionKey, fresh);
  }, delayMs);
  sessionHistoryTimers.set(sessionKey, timer);
}

function startBrowserDiscoveryRealtimeLoop() {
  if (browserDiscoveryTimer) return;
  browserDiscoveryTimer = setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const browserInventory = await getBrowserInventorySnapshot();
      const attachedBrowser = getAttachedBrowserSummary();
      const fingerprint = fingerprintBrowserSnapshot(browserInventory, attachedBrowser);
      if (fingerprint === lastRealtimeFingerprint.browser) return;
      lastRealtimeFingerprint.browser = fingerprint;
      broadcastRealtimeEvents([
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory,
            attachedBrowser,
            error: null,
          },
          { snapshot: true, entityId: 'browser-inventory', health: { state: 'live' } },
        ),
      ]);
    } catch {
      // Best-effort discovery loop
    }
  }, BROWSER_DISCOVERY_INTERVAL_MS);
  if (browserDiscoveryTimer.unref) browserDiscoveryTimer.unref();
}

function attachedBrowserFingerprint(summary: ReturnType<typeof getAttachedBrowserSummary>) {
  if (!summary) return 'no-attached-browser';
  let fp = `${summary.provider}\x01${summary.surface.id}\x01${summary.surface.status}\x01${summary.surface.url}\x01${summary.surface.title}\x01${summary.browserName}\x01${summary.browserVersion}\x01${summary.attachedAt}\x01${summary.note ?? ''}`;
  for (const page of summary.pages) {
    fp += `\x02${page.id}\x01${page.title}\x01${page.url}\x01${page.status}\x01${page.type}`;
  }
  return fp;
}

function startAttachedBrowserRefreshLoop() {
  if (attachedBrowserRefreshTimer) return;
  attachedBrowserRefreshTimer = setInterval(async () => {
    if (clients.size === 0) return;
    const attachedBrowser = getAttachedBrowserSummary();
    if (!attachedBrowser) return;

    const provider = getBrowserProvider(attachedBrowser.provider);
    if (!provider?.attachSurface) return;

    try {
      const refreshed = await provider.attachSurface(attachedBrowser.surface.id);
      const previousFingerprint = attachedBrowserFingerprint(attachedBrowser);
      const nextFingerprint = attachedBrowserFingerprint(refreshed);
      if (previousFingerprint === nextFingerprint) return;

      setAttachedBrowserSummary(refreshed);

      scheduleRealtimeRuntimeRefresh({ reason: `browser.attach-refresh:${refreshed.provider}`, fresh: true });
    } catch {
      // If the attached surface disappears, keep the last known state until an explicit attach replaces it.
    }
  }, ATTACHED_BROWSER_REFRESH_MS);
  if (attachedBrowserRefreshTimer.unref) attachedBrowserRefreshTimer.unref();
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
    case 'realtime-subscribe': {
      const rawSubscriptions = Array.isArray(msg.subscriptions) ? msg.subscriptions as Array<Record<string, unknown>> : [];
      const subscriptions: RealtimeSubscription[] = [];
      for (const item of rawSubscriptions) {
        const sessionKey = typeof item.sessionKey === 'string' ? item.sessionKey : null;
        const stream = normalizeRealtimeStreamKey(typeof item.stream === 'string' ? item.stream : undefined, sessionKey);
        if (!stream) continue;
        const since = typeof item.since === 'number' && Number.isFinite(item.since) ? item.since : undefined;
        subscriptions.push({ stream, since });
      }

      replayRealtimeSubscriptions(client, subscriptions);
      for (const subscription of subscriptions) {
        if (subscription.since != null) continue;
        void buildBootstrapEvents(subscription.stream).then((events) => {
          sendRealtimeBatch(client, subscription.stream, 'bootstrap', events);
        });
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
    case 'terminal-image':
      handleTerminalImage(client, msg);
      break;
    case 'agent-kill':
      handleAgentKill(client, msg);
      break;

    // ── Orchestrator channel ──
    case 'orchestrator-subscribe':
      handleOrchestratorSubscribe(client, msg);
      break;
    case 'orchestrator-send':
      handleOrchestratorSendMsg(client, msg);
      break;
    case 'orchestrator-status':
      handleOrchestratorStatus(client, msg);
      break;
    case 'orchestrator-unsubscribe':
      orchestratorSubscriptions.delete(client.id);
      break;
  }
}

// ── Orchestrator channel handlers ──

async function handleOrchestratorSubscribe(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = normalizeOrchestratorRepoPath(typeof msg.repoPath === 'string' ? msg.repoPath : null);
  if (!repoPath) return;

  try {
    const session = ensureOrchestratorSession(repoPath);
    orchestratorSubscriptions.set(client.id, {
      clientId: client.id,
      repoPath,
      sessionName: session.sessionName,
    });

    // No PTY to hook — the new approach spawns a process per message
    // and streams structured JSON events directly to WS subscribers.
    send(client, {
      channel: 'orchestrator',
      event: 'status',
      data: { status: session.status, repoPath, sessionName: session.sessionName },
    });
    console.log(`[ws-server] Client ${client.id} subscribed to orchestrator for ${repoPath}`);
  } catch (err) {
    send(client, {
      channel: 'orchestrator',
      event: 'error',
      data: { error: err instanceof Error ? err.message : 'Failed to start orchestrator session', repoPath },
    });
  }
}

async function handleOrchestratorSendMsg(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = normalizeOrchestratorRepoPath(typeof msg.repoPath === 'string' ? msg.repoPath : null);
  const message = typeof msg.message === 'string' ? msg.message : null;
  if (!repoPath || !message) return;

  try {
    let session = getOrchestratorSession(repoPath);
    if (!session || session.status === 'dead') {
      session = ensureOrchestratorSession(repoPath);
    }

    // Ensure subscription exists
    if (!orchestratorSubscriptions.has(client.id)) {
      orchestratorSubscriptions.set(client.id, {
        clientId: client.id,
        repoPath,
        sessionName: session.sessionName,
      });
    }

    // Emit busy status
    const busyMsg = JSON.stringify({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'busy', repoPath },
    });
    for (const [cid, sub] of orchestratorSubscriptions) {
      if (sub.sessionName === session.sessionName) {
        const c = clients.get(cid);
        if (c) sendRaw(c, busyMsg);
      }
    }

    // Spawn claude process and stream structured JSON events to subscribers
    await sendToOrchestrator(session, message, (event) => {
      // Find all subscribed clients for this session
      const subscribedClients: string[] = [];
      for (const [cid, sub] of orchestratorSubscriptions) {
        if (sub.sessionName === session!.sessionName) subscribedClients.push(cid);
      }
      if (subscribedClients.length === 0) return;

      let wsMsg: string | null = null;

      switch (event.type) {
        case 'text':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'output',
            data: { text: event.text, repoPath, thinking: false },
          });
          break;

        case 'thinking':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'output',
            data: { text: event.text, repoPath, thinking: true },
          });
          break;

        case 'tool_use':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'tool-use',
            data: { name: event.name, repoPath },
          });
          break;

        case 'done':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'status',
            data: { status: 'ready', repoPath },
          });
          break;

        case 'error':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'error',
            data: { error: event.error, repoPath },
          });
          break;
      }

      if (wsMsg) {
        for (const cid of subscribedClients) {
          const c = clients.get(cid);
          if (c) sendRaw(c, wsMsg);
        }
      }
    });

    // After user message completes, drain any queued supervisor escalations
    void drainOrchestratorAutoQueue();
  } catch (err) {
    send(client, {
      channel: 'orchestrator',
      event: 'error',
      data: { error: err instanceof Error ? err.message : 'Failed to send message', repoPath },
    });
  }
}

function handleOrchestratorStatus(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = normalizeOrchestratorRepoPath(typeof msg.repoPath === 'string' ? msg.repoPath : null);
  if (!repoPath) return;

  const session = getOrchestratorSession(repoPath);
  send(client, {
    channel: 'orchestrator',
    event: 'status',
    data: {
      status: session?.status ?? 'dead',
      repoPath,
      sessionName: session?.sessionName ?? null,
    },
  });
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
    scheduleRealtimeSessionHistoryRefresh(delta.sessionKey, true);
    scheduleRealtimeRuntimeRefresh({ reason: 'chat.done', fresh: true });
    scheduleRealtimeMobileInboxRefresh(250, true);
  } else if (delta.state === 'error' || delta.state === 'aborted') {
    broadcast({ channel: 'chat', event: 'error', data: { state: delta.state, error: delta.error, runId: delta.runId } }, sessionFilter);
    scheduleEventDrivenInboxPush();
    scheduleRealtimeSessionHistoryRefresh(delta.sessionKey, true);
    scheduleRealtimeRuntimeRefresh({ reason: `chat.${delta.state}`, fresh: true });
    scheduleRealtimeMobileInboxRefresh(250, true);
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

/** Find an existing detached dashboard PTY session to reuse, or return null. */
function findExistingDashSession(): string | null {
  for (const [sessionName, attachment] of terminalAttachments) {
    if (attachment.kind === 'dash-shell' && attachment.clientIds.size === 0) {
      return sessionName;
    }
  }
  return null;
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
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;

  // Only opportunistically reuse orphaned dashboard shells for non-targeted creates.
  // Explicit request IDs should always receive a fresh tmux session so ownership is deterministic.
  const existing = findExistingDashSession();
  if (!requestId && existing) {
    console.log(`[ws-server] Reusing existing dashboard PTY session: ${existing}`);
    sendTerminal(client, 'created', { sessionName: existing, requestId });
    handleTerminalAttach(client, { sessionName: existing, cols, rows });
    return;
  }

  const shortId = randomUUID().slice(0, 8);
  const sessionName = `cortex-dash-${shortId}`;

  try {
    const ptyProcess = spawnDashShellPty(sessionName, cols, rows);
    const now = Date.now();
    const attachment: TerminalAttachment = {
      id: randomUUID(),
      sessionName,
      kind: 'dash-shell',
      ptyProcess,
      clientIds: new Set(),
      cols,
      rows,
      batchBuffer: '',
      batchTimer: null,
      lastOutputAt: now,
      createdAt: now,
      orphanTimer: null,
      scrollbackChunks: [],
      scrollbackBytes: 0,
    };
    terminalAttachments.set(sessionName, attachment);
    registerTerminalAttachment(attachment);
    console.log(`[ws-server] Created dashboard PTY session: ${sessionName}`);

    sendTerminal(client, 'created', { sessionName, requestId });
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
    if (attachment.orphanTimer) {
      clearTimeout(attachment.orphanTimer);
      attachment.orphanTimer = null;
    }
    attachment.clientIds.add(client.id);
    client.terminalSessions.add(sessionName);
    sendTerminal(client, 'attached', { sessionName });
    if (attachment.kind === 'dash-shell') {
      sendTerminalScrollback(client, attachment);
    }
    console.log(`[ws-server] Client ${client.id} attached to existing terminal ${sessionName}`);
    return;
  }

  if (isDashTerminalSession(sessionName)) {
    sendTerminal(client, 'error', { sessionName, error: 'Dashboard terminal session no longer exists. Create a new shell.' });
    return;
  }

  // Spawn a new PTY that attaches to the tmux session
  try {
    const ptyProcess = spawnTmuxAttachPty(sessionName, cols, rows);

    const now = Date.now();
    attachment = {
      id: randomUUID(),
      sessionName,
      kind: 'tmux-attach',
      ptyProcess,
      clientIds: new Set([client.id]),
      cols,
      rows,
      batchBuffer: '',
      batchTimer: null,
      lastOutputAt: now,
      createdAt: now,
      orphanTimer: null,
      scrollbackChunks: [],
      scrollbackBytes: 0,
    };

    terminalAttachments.set(sessionName, attachment);
    client.terminalSessions.add(sessionName);
    registerTerminalAttachment(attachment);

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

function handleTerminalImage(_client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const filePath = msg.filePath as string;
  if (!sessionName || !filePath) return;

  try {
    const resolved = filePath.replace(/^~/, process.env.HOME ?? '/tmp');
    const data = readFileSync(resolved);
    const b64 = data.toString('base64');
    const filename = basename(resolved);
    // Send raw components — client builds the IIP escape sequence
    const attachment = terminalAttachments.get(sessionName);
    if (!attachment) {
      console.log(`[ws-server] terminal-image: no attachment for ${sessionName}`);
      return;
    }

    const imageMsg = JSON.stringify({
      channel: 'terminal',
      event: 'image',
      data: {
        sessionName,
        filename,
        imageB64: b64,
      },
    });

    for (const cid of attachment.clientIds) {
      const c = clients.get(cid);
      if (c) sendRaw(c, imageMsg);
    }
    console.log(`[ws-server] Sent image to ${attachment.clientIds.size} client(s) on ${sessionName}`);
  } catch (err) {
    console.log(`[ws-server] terminal-image error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
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
    if (attachment.kind === 'dash-shell') {
      if (attachment.orphanTimer) clearTimeout(attachment.orphanTimer);
      attachment.orphanTimer = setTimeout(() => {
        const latest = terminalAttachments.get(sessionName);
        if (!latest || latest.clientIds.size > 0) return;
        console.log(`[ws-server] Reaping idle dashboard PTY session: ${sessionName}`);
        if (latest.batchTimer) clearTimeout(latest.batchTimer);
        try { latest.ptyProcess.kill(); } catch { /* already gone */ }
        terminalAttachments.delete(sessionName);
      }, DASH_SESSION_ORPHAN_TTL_MS);
      console.log(`[ws-server] Dashboard terminal ${sessionName} detached — keeping PTY alive for reattach`);
      return;
    }

    console.log(`[ws-server] No clients left for terminal ${sessionName} — destroying PTY`);
    if (attachment.batchTimer) clearTimeout(attachment.batchTimer);
    try { attachment.ptyProcess.kill(); } catch { /* already gone */ }
    terminalAttachments.delete(sessionName);
  }
}

// ── Agent Lifecycle ──

type LifecycleState = 'active' | 'completed' | 'failed' | 'killed' | 'stalled';

// Track lifecycle state per session name
const agentLifecycleState = new Map<string, {
  state: LifecycleState;
  exitCode?: number;
  killedBy?: string;
  ts: number;
}>();

// ── Stall Detection ──
// Only monitor launched agent terminals (cortex-codex-*, cortex-claude-*)
// NOT dashboard terminals (cortex-dash-*) or background helper sessions
const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes with no output
const STALL_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s
const STALL_GRACE_MS = 60 * 1000; // ignore first 60s after creation (agent startup)

function isMonitoredAgent(sessionName: string): boolean {
  // Only monitor IDE-launched agent terminals
  // cortex-codex-* and cortex-claude-* are launched agents
  // cortex-dash-* are user dashboard terminals — not monitored
  // Background helper sessions are not monitored
  return sessionName.startsWith('cortex-codex-') || sessionName.startsWith('cortex-claude-');
}

function checkForStalledAgents() {
  const now = Date.now();
  for (const [sessionName, att] of terminalAttachments) {
    if (!isMonitoredAgent(sessionName)) continue;

    // Skip if within grace period (agent startup takes time)
    if (now - att.createdAt < STALL_GRACE_MS) continue;

    // Skip if already in a terminal lifecycle state
    const existing = agentLifecycleState.get(sessionName);
    if (existing && (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'killed')) continue;

    const silentMs = now - att.lastOutputAt;
    if (silentMs >= STALL_THRESHOLD_MS) {
      // Only broadcast if not already stalled (avoid spam)
      if (!existing || existing.state !== 'stalled') {
        console.log(`[ws-server] Stall detected: ${sessionName} — no output for ${Math.round(silentMs / 60000)}m`);
        broadcastLifecycle(sessionName, 'stalled');
      }
    } else if (existing?.state === 'stalled') {
      // Agent resumed producing output — clear stall
      console.log(`[ws-server] Stall cleared: ${sessionName} — output resumed`);
      broadcastLifecycle(sessionName, 'active');
    }
  }
}

// Start stall detection interval (cleaned up on shutdown)
const stallCheckTimer = setInterval(checkForStalledAgents, STALL_CHECK_INTERVAL_MS);

function broadcastLifecycle(sessionName: string, state: LifecycleState, exitCode?: number) {
  const entry = { state, exitCode, ts: Date.now() };
  agentLifecycleState.set(sessionName, entry);

  const msg = JSON.stringify({
    channel: 'agent-lifecycle',
    event: state,
    data: { sessionName, state, exitCode, ts: entry.ts },
  });

  // Broadcast to ALL connected clients (not just terminal subscribers)
  for (const [, c] of clients) {
    sendRaw(c, msg);
  }
  scheduleRealtimeRuntimeRefresh({ reason: `terminal.${state}`, fresh: true });
  scheduleRealtimeMobileInboxRefresh(250, true);
  console.log(`[ws-server] Agent lifecycle: ${sessionName} → ${state}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`);
}

function handleAgentKill(_client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const signal = (msg.signal as string) ?? 'SIGTERM';
  if (!sessionName) return;

  terminateTerminalSession(sessionName, signal);
}

function terminateTerminalSession(sessionName: string, signal: string = 'SIGTERM') {
  if (!sessionName) return;

  console.log(`[ws-server] Kill request for ${sessionName} (signal: ${signal})`);

  // 1. Try killing via PTY attachment (Codex / Claude Code terminals)
  const attachment = terminalAttachments.get(sessionName);
  if (attachment) {
    try {
      if (signal === 'SIGINT') {
        // Send Ctrl+C to the PTY (interrupt, not kill)
        attachment.ptyProcess.write('\x03');
        console.log(`[ws-server] Sent Ctrl+C to ${sessionName}`);
        return;
      }

      attachment.ptyProcess.kill();
      console.log(`[ws-server] Killed PTY for ${sessionName}`);
    } catch (err) {
      console.error(`[ws-server] Failed to kill PTY for ${sessionName}:`, err);
    }
    // Lifecycle broadcast happens via onExit handler
    return;
  }

  // 2. Try killing tmux session directly (if PTY already detached but tmux lives)
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { timeout: 2000 });
    execSync(`tmux kill-session -t ${sessionName}`, { timeout: 3000 });
    console.log(`[ws-server] Killed tmux session: ${sessionName}`);
    broadcastLifecycle(sessionName, 'killed');
    return;
  } catch { /* no tmux session */ }

  // 3. No PTY or tmux session remains — broadcast the kill state so the UI can reconcile.
  if (sessionName.startsWith('cortex-')) {
    console.log(`[ws-server] No live PTY found for ${sessionName} — skipping stale kill broadcast`);
    return;
  }
  console.log(`[ws-server] No PTY/tmux found for ${sessionName} — broadcasting killed state`);
  broadcastLifecycle(sessionName, 'killed');
}

function isAuthorizedInternalRequest(req: import('http').IncomingMessage) {
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${WS_TOKEN}`;
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

  if (req.url === '/terminal-spawn' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: InternalTerminalSpawnPayload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as InternalTerminalSpawnPayload;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const shellCommand = payload?.shellCommand?.trim();
      const cwd = payload?.cwd?.trim();
      const cols = typeof payload?.cols === 'number' ? payload.cols : 120;
      const rows = typeof payload?.rows === 'number' ? payload.rows : 30;
      if (!sessionName || !shellCommand || !cwd) {
        res.writeHead(400);
        res.end('sessionName, shellCommand, and cwd are required');
        return;
      }
      if (!/^cortex-[a-z0-9_-]+$/i.test(sessionName)) {
        res.writeHead(400);
        res.end('invalid session name');
        return;
      }
      if (!pty) {
        res.writeHead(503);
        res.end('node-pty unavailable');
        return;
      }
      if (terminalAttachments.has(sessionName)) {
        const existing = terminalAttachments.get(sessionName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionName, pid: existing?.ptyProcess?.pid ?? null }));
        return;
      }

      try {
        const ptyProcess = spawnManagedCommandPty(sessionName, shellCommand, cwd, cols, rows, payload?.env);
        const now = Date.now();
        const attachment: TerminalAttachment = {
          id: randomUUID(),
          sessionName,
          kind: 'managed-process',
          ptyProcess,
          clientIds: new Set(),
          cols,
          rows,
          batchBuffer: '',
          batchTimer: null,
          lastOutputAt: now,
          createdAt: now,
          orphanTimer: null,
          scrollbackChunks: [],
          scrollbackBytes: 0,
        };
        terminalAttachments.set(sessionName, attachment);
        registerTerminalAttachment(attachment);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionName, pid: ptyProcess.pid ?? null }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to spawn terminal session' }));
      }
    });
    return;
  }

  if (req.url === '/terminal-sessions' && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const sessions = [...terminalAttachments.values()]
      .filter((attachment) => attachment.kind === 'dash-shell')
      .map((attachment) => attachment.sessionName);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (req.url?.startsWith('/terminal-alive') && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const parsed = new URL(req.url, `http://127.0.0.1:${WS_PORT}`);
    const sessionName = parsed.searchParams.get('session') ?? '';
    const alive = sessionName ? terminalAttachments.has(sessionName) : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive }));
    return;
  }

  if (req.url === '/terminal-signal' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: InternalTerminalSignalPayload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as InternalTerminalSignalPayload;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const signal = payload?.signal?.trim() || 'SIGTERM';
      if (!sessionName) {
        res.writeHead(400);
        res.end('sessionName required');
        return;
      }

      try {
        terminateTerminalSession(sessionName, signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to signal terminal session' }));
      }
    });
    return;
  }

  if (req.url === '/terminal-exec' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: { sessionName?: string; command?: string } | null = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessionName?: string; command?: string };
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const command = payload?.command;
      if (!sessionName || !command) {
        res.writeHead(400);
        res.end('sessionName and command required');
        return;
      }

      const attachment = terminalAttachments.get(sessionName);
      if (!attachment) {
        res.writeHead(404);
        res.end('session not found');
        return;
      }

      try {
        // PTY raw-mode TUIs (like Claude Code) interpret \r as Enter, not \n
        attachment.ptyProcess.write(`${command}\r`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to write to terminal' }));
      }
    });
    return;
  }

  if (req.url?.startsWith('/terminal-scrollback') && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${WS_PORT}`);
    const sessionName = url.searchParams.get('sessionName')?.trim();
    if (!sessionName) {
      res.writeHead(400);
      res.end('sessionName required');
      return;
    }

    const attachment = terminalAttachments.get(sessionName);
    if (!attachment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }

    const scrollback = attachment.scrollbackChunks.join('');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scrollback }));
    return;
  }

  // ── Supervisor watch endpoint ──
  if (req.url === '/supervisor/watch' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          surfaceId?: string;
          repoPath?: string;
          name?: string;
          prompt?: string;
        };
        if (!body.surfaceId || !body.repoPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'surfaceId and repoPath required' }));
          return;
        }
        registerWatchedAgent(
          body.surfaceId,
          body.repoPath,
          body.name ?? 'Unnamed agent',
          body.prompt ?? '',
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, watching: body.surfaceId }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }

  if (req.url === '/internal/realtime' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: RealtimeInternalRequest | null = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as RealtimeInternalRequest;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      if (!payload) {
        res.writeHead(400);
        res.end('missing payload');
        return;
      }

      if (payload.kind === 'mutation') {
        const event = buildRealtimeEnvelope(
          'global',
          'mutation',
          payload.mutation.status === 'pending' ? 'mutation.record' : 'mutation.settled',
          { mutation: payload.mutation },
          {
            entityId: payload.mutation.surfaceId ?? payload.mutation.sessionKey ?? payload.mutation.mutationId,
            health: { state: 'live' },
          },
        );
        broadcastRealtimeEvents([event]);
        const laneLifecyclePayload = mutationToLaneLifecyclePayload(payload.mutation);
        if (laneLifecyclePayload) {
          broadcast({ channel: 'lane-lifecycle', event: 'update', data: laneLifecyclePayload });
          console.log(`[lane-lifecycle] Broadcast ${laneLifecyclePayload.laneId} ${laneLifecyclePayload.previousStatus ?? 'new'} -> ${laneLifecyclePayload.status}`);
        }

        if (payload.refreshTargets?.includes('global')) {
          scheduleRealtimeRuntimeRefresh({ fresh: payload.fresh, reason: payload.mutation.action });
        }
        if (payload.refreshTargets?.includes('mobileInbox')) {
          scheduleRealtimeMobileInboxRefresh(250, Boolean(payload.fresh));
        }
        if (payload.refreshTargets?.includes('sessionHistory')) {
          for (const sessionKey of payload.sessionKeys ?? []) {
            scheduleRealtimeSessionHistoryRefresh(sessionKey, true);
          }
        }

        res.writeHead(202);
        res.end('accepted');
        return;
      }

      if (payload.kind === 'refresh') {
        if (payload.targets.includes('global')) {
          scheduleRealtimeRuntimeRefresh({ fresh: payload.fresh, reason: payload.reason });
        }
        if (payload.targets.includes('mobileInbox')) {
          scheduleRealtimeMobileInboxRefresh(250, Boolean(payload.fresh));
        }
        if (payload.targets.includes('sessionHistory')) {
          for (const sessionKey of payload.sessionKeys ?? []) {
            scheduleRealtimeSessionHistoryRefresh(sessionKey, Boolean(payload.fresh));
          }
        }

        res.writeHead(202);
        res.end('accepted');
        return;
      }

      res.writeHead(400);
      res.end('unsupported kind');
    });
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: clients.size,
      gateway: 'disabled',
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
    realtimeSubscriptions: [],
    backpressureQueue: [],
    flushTimer: null,
  };

  clients.set(client.id, client);
  console.log(`[ws-server] Client connected: ${client.id} (${clients.size} total)`);

  // Send welcome with connection info
  send(client, {
    channel: 'system',
    event: 'connected',
    data: {
      clientId: client.id,
      gateway: 'disabled',
      realtimeSeq,
    },
  });

  // Send initial inbox
  void syncClientInbox(client);
  startBrowserDiscoveryRealtimeLoop();

  ws.on('message', (raw) => {
    handleClientMessage(client, typeof raw === 'string' ? raw : raw.toString());
  });

  ws.on('pong', () => { client.alive = true; });

  ws.on('close', () => {
    // Stop backpressure flush timer
    stopFlushTimer(client);
    client.backpressureQueue.length = 0;
    // Detach from all terminal sessions
    for (const sessionName of client.terminalSessions) {
      removeClientFromTerminal(client.id, sessionName);
    }
    // Clean up orchestrator subscription
    orchestratorSubscriptions.delete(client.id);
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
      stopFlushTimer(client);
      client.ws.terminate();
      clients.delete(client.id);
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, PING_INTERVAL_MS);

// ── Git watcher — push diff stats + file changes on changes ──

const REPO_ROOT = resolve(process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd());
const GIT_DIR = resolve(REPO_ROOT, '.git');
let lastDiffHash = '';
let diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let reviewPollTimer: ReturnType<typeof setInterval> | null = null;
const reviewTargetHashes = new Map<string, string>();
const REVIEW_POLL_INTERVAL_MS = 10_000;

function shortHome(filePath: string) {
  const home = process.env.HOME ?? homedir();
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
    scheduleRealtimeRuntimeRefresh({ reason: 'review.refresh', fresh: true });
    scheduleRealtimeMobileInboxRefresh(250, true);
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

// Session preservation strategy:
// - cortex-dash-* sessions survive server restarts for reuse (findExistingDashSession).
// - On WS disconnect, a 10s grace period allows hot-reload reconnects before killing.
// - cortex-codex-*/cortex-claude-* sessions persist indefinitely (stall detector manages them).

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
            console.log(`[ws-server] o8 WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);
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

// Dashboard tmux sessions (cortex-dash-*) are NOT purged on startup.
// The reuse logic in handleTerminalCreate will find and reattach to them,
// and the disconnect handler gives a 10s grace period for hot-reload reconnects.
// Agent-launched sessions (cortex-codex-*, cortex-claude-*) are separately
// managed by the stall detector and lifecycle system.

async function bootstrapWsServer() {
  try {
    await rehydrateOrchestratorSessions();
  } catch (error) {
    console.warn(
      `[orchestrator-rehydrate] WS startup rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  startPollingLoops();
  startBrowserDiscoveryRealtimeLoop();
  startAttachedBrowserRefreshLoop();
  scheduleRealtimeRuntimeRefresh({ reason: 'startup', fresh: false });
  scheduleRealtimeMobileInboxRefresh(500);

  httpServer.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`[ws-server] o8 WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);

    // ── Start Agent Supervisor ──
    const NEXT_ORIGIN = `http://localhost:${process.env.PORT || '3001'}`;
    const supervisorCallbacks: SupervisorCallbacks = {
      async fetchFleetStatus() {
        const res = await fetch(`${NEXT_ORIGIN}/api/runtime/inventory?fresh=1`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json() as { agents?: Array<Record<string, unknown>> };
        return ((data.agents ?? []) as Array<Record<string, unknown>>)
          .filter((a) => a.runtime === 'codex' || a.runtime === 'claude-code')
          .map((a) => ({
            sessionKey: a.sessionKey as string,
            status: a.status as string,
            name: a.name as string,
            workspace: a.workspace as string,
            currentTask: a.currentTask as string,
          }));
      },
      async fetchTranscript(sessionKey, limit) {
        const res = await fetch(`${NEXT_ORIGIN}/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json() as { transcript?: Array<Record<string, unknown>> };
        return ((data.transcript ?? []) as Array<Record<string, unknown>>).map((e) => ({
          id: (e.id as string) ?? '',
          role: (e.role as string) ?? '',
          text: (e.text as string) ?? '',
          timestamp: e.timestamp as number | undefined,
          timestampLabel: e.timestampLabel as string | undefined,
          toolName: e.toolName as string | undefined,
        }));
      },
      async steerAgent(surfaceId, message) {
        await fetch(`${NEXT_ORIGIN}/api/runtime/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'steer', surfaceId, message }),
          signal: AbortSignal.timeout(8000),
        });
      },
      async interruptAgent(surfaceId) {
        await fetch(`${NEXT_ORIGIN}/api/runtime/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'interrupt', surfaceId }),
          signal: AbortSignal.timeout(8000),
        });
      },
      async relaunchAgent(prompt, repoPath, taskName) {
        const res = await fetch(`${NEXT_ORIGIN}/api/runtime/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime: 'codex', prompt, repoPath, cwd: repoPath, taskName }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json() as { ok?: boolean; surfaceId?: string };
        return data.ok ? (data.surfaceId as string) : null;
      },
      broadcastAgentUpdate(update: AgentUpdateEvent) {
        const msg = JSON.stringify({
          channel: 'orchestrator',
          event: 'agent-update',
          data: update,
        });
        for (const [cid] of orchestratorSubscriptions) {
          const c = clients.get(cid);
          if (c) sendRaw(c, msg);
        }
      },
      queueOrchestratorEscalation,
      onAgentProgress(surfaceId, lastMessage) {
        const watched = getWatchedAgents().find((agent) => agent.surfaceId === surfaceId);
        const update: AgentUpdateEvent = {
          surfaceId,
          name: watched?.name ?? surfaceId,
          status: watched?.lastStatus ?? 'running',
          detail: lastMessage,
          repoPath: watched?.repoPath,
        };
        console.log(`[supervisor] Agent ${surfaceId} progress: ${lastMessage.slice(0, 80)}`);

        const msg = JSON.stringify({
          channel: 'orchestrator',
          event: 'agent-update',
          data: update,
        });
        for (const [cid] of orchestratorSubscriptions) {
          const c = clients.get(cid);
          if (c) sendRaw(c, msg);
        }
      },
      onAgentCompletion(surfaceId, outcome) {
        void (async () => {
          try {
            const { findLaneBySession, setLaneStatus } = await import('@/lib/lane/registry');
            const lane = findLaneBySession(surfaceId);
            if (!lane) {
              return;
            }

            if (outcome === 'completed') {
              const updated = setLaneStatus(lane.id, 'reviewing', 'system', 'agent_completed');
              if (updated) {
                const packetId = updated.packetId ?? lane.packetId;
                const sessionKey = updated.sessionKey ?? surfaceId;
                if (packetId) {
                  try {
                    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
                    await capturePacketCompletionContext(packetId, sessionKey);
                  } catch (error) {
                    console.error(`[context-relay] Failed to capture completion context for packet ${packetId}:`, error);
                  }
                } else {
                  console.warn(`[context-relay] Skipped completion context capture for lane ${lane.id}; packetId missing`);
                }
                const { triggerAutoReview } = await import('@/lib/lane/auto-review');
                triggerAutoReview(updated);
                await runHeadlessSprintTick({
                  releasePacketIds: packetId ? [packetId] : undefined,
                });
              }
              console.log(`[supervisor] Agent ${surfaceId} completed, lane ${lane.id} -> reviewing`);
              return;
            }

            setLaneStatus(lane.id, 'awaiting_input', 'system', 'agent_failed');
            console.log(`[supervisor] Agent ${surfaceId} failed, lane ${lane.id} -> awaiting_input`);
          } catch (error) {
            console.error('[supervisor] Completion callback failed:', error);
          }
        })();
      },
    };
    startSupervisorLoop(supervisorCallbacks);
    stopHeadlessLoop = startHeadlessSprintLoop(10_000);
  });
}

void bootstrapWsServer();

// ── Graceful shutdown ──

function shutdown(signal: string) {
  console.log(`[ws-server] ${signal} received — shutting down gracefully`);

  // Stop agent supervisor and stall detection
  stopSupervisorLoop();
  stopHeadlessLoop?.();
  stopHeadlessLoop = null;
  clearInterval(stallCheckTimer);
  if (runtimeRefreshTimer) clearTimeout(runtimeRefreshTimer);
  if (mobileRefreshTimer) clearTimeout(mobileRefreshTimer);
  for (const timer of sessionHistoryTimers.values()) {
    clearTimeout(timer);
  }
  sessionHistoryTimers.clear();
  if (browserDiscoveryTimer) clearInterval(browserDiscoveryTimer);
  if (attachedBrowserRefreshTimer) clearInterval(attachedBrowserRefreshTimer);

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
