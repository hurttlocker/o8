import 'server-only';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

import {
  resolveCodexRealtimeTransportAccess,
  type CodexRealtimeTransportAccess,
} from './realtime-access';
import {
  CODEX_REALTIME_VERSION,
  DEFAULT_INSTRUCTIONS,
  buildCodexRealtimeStartParams,
  type CodexRealtimeOutputModality,
  type CodexRealtimeTransport,
} from './realtime-session-config';

const REQUEST_TIMEOUT_MS = 8_000;
const START_EVENT_TIMEOUT_MS = 12_000;
const SESSION_IDLE_TTL_MS = 10 * 60_000;
const MAX_EVENTS = 1_024;

type JsonRpcId = number | string;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

interface AppServerClientOptions {
  binaryPath: string;
  codexHome: string;
  onNotification: (notification: AppServerNotification) => void;
  onExit: (detail: string) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One isolated Codex app-server process per launch-scoped voice session. The
 * protocol remains experimental, so this client deliberately implements only
 * initialize + the exact thread/realtime and text-fallback calls we consume.
 */
class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onNotification: AppServerClientOptions['onNotification'];
  private readonly onExit: AppServerClientOptions['onExit'];
  private nextId = 1;
  private stdout = '';
  private closed = false;
  private stderrTail: string[] = [];

  constructor(options: AppServerClientOptions) {
    this.onNotification = options.onNotification;
    this.onExit = options.onExit;
    this.child = spawn(options.binaryPath, ['app-server', '--stdio'], {
      env: {
        ...process.env,
        CODEX_HOME: options.codexHome,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stderr.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      const detail = `Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      this.closed = true;
      this.failAll(new Error(detail));
      this.onExit(detail);
    });
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    const lines = this.stdout.split(/\r?\n/);
    this.stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: Record<string, unknown> | null = null;
      try {
        message = record(JSON.parse(line));
      } catch {
        continue;
      }
      if (!message) continue;

      if (message.id !== undefined && ('result' in message || 'error' in message)) {
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (!pending) continue;
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(
            `Codex app-server ${pending.method}: ${JSON.stringify(message.error)}`,
          ));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }

      if (message.id !== undefined && typeof message.method === 'string') {
        // This launch slice does not surface app-server approval/elicitation
        // requests. Reject unknown server requests promptly instead of leaving
        // the Codex turn hung; the thread itself runs read-only + never-approve.
        this.write({
          id: message.id as JsonRpcId,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        });
        continue;
      }

      if (typeof message.method === 'string') {
        this.onNotification({
          method: message.method,
          params: record(message.params) ?? {},
        });
      }
    }
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        const stderr = this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' | ')}` : '';
        reject(new Error(`${method} timed out after ${timeoutMs}ms${stderr}`));
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'o8-connected-voice', version: '1' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Codex app-server session closed'));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 1_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export type CodexRealtimeSessionMode = 'codex-oauth' | 'text';

export interface CodexRealtimeEvent {
  seq: number;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

interface CodexRealtimeSession {
  id: string;
  threadId: string;
  mode: CodexRealtimeSessionMode;
  transport: CodexRealtimeTransport | 'text';
  client: CodexAppServerClient;
  events: CodexRealtimeEvent[];
  nextSeq: number;
  waiters: Set<() => void>;
  lastTouchedAt: number;
  closed: boolean;
  fallbackReason: string | null;
}

export interface StartCodexRealtimeSessionInput {
  sdp?: string;
  transport?: CodexRealtimeTransport;
  outputModality?: CodexRealtimeOutputModality;
  prompt?: string | null;
  model?: string;
  voice?: string;
  allowTextFallback?: boolean;
}

export interface StartCodexRealtimeSessionResult {
  sessionId: string;
  threadId: string;
  mode: CodexRealtimeSessionMode;
  transport: CodexRealtimeTransport | 'text';
  version: typeof CODEX_REALTIME_VERSION | null;
  sdp: string | null;
  fallbackReason: string | null;
  access: CodexRealtimeTransportAccess;
}

export interface CodexRealtimeAudioChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel?: number | null;
  itemId?: string | null;
}

export class CodexRealtimeTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'CodexRealtimeTransportError';
  }
}

const sessions = new Map<string, CodexRealtimeSession>();
let sessionSequence = 0;

function sessionId(): string {
  sessionSequence += 1;
  return `codex-realtime-${Date.now().toString(36)}-${sessionSequence.toString(36)}`;
}

function pushEvent(
  session: CodexRealtimeSession,
  method: string,
  params: Record<string, unknown>,
): void {
  const event: CodexRealtimeEvent = {
    seq: session.nextSeq++,
    method,
    params,
    at: Date.now(),
  };
  session.events.push(event);
  if (session.events.length > MAX_EVENTS) {
    session.events.splice(0, session.events.length - MAX_EVENTS);
  }
  session.lastTouchedAt = Date.now();
  for (const wake of session.waiters) wake();
}

function recordNotification(
  session: CodexRealtimeSession,
  notification: AppServerNotification,
): void {
  const { method, params } = notification;
  if (method.startsWith('thread/realtime/')) {
    pushEvent(session, method, params);
    return;
  }

  if (session.mode !== 'text') return;
  if (method === 'item/agentMessage/delta') {
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (delta) {
      pushEvent(session, 'thread/realtime/transcript/delta', {
        threadId: session.threadId,
        role: 'assistant',
        delta,
      });
    }
    return;
  }
  if (method === 'item/completed') {
    const item = record(params.item);
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      pushEvent(session, 'thread/realtime/transcript/done', {
        threadId: session.threadId,
        role: 'assistant',
        text: item.text,
      });
    }
    return;
  }
  if (method === 'turn/completed' || method === 'error') {
    pushEvent(session, method, params);
  }
}

function getSession(id: string): CodexRealtimeSession {
  const session = sessions.get(id);
  if (!session || session.closed) {
    throw new CodexRealtimeTransportError(
      'session_not_found',
      'Codex realtime session was not found or has already closed.',
      404,
    );
  }
  session.lastTouchedAt = Date.now();
  return session;
}

async function closeSession(session: CodexRealtimeSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  sessions.delete(session.id);
  for (const wake of session.waiters) wake();
  session.waiters.clear();
  await session.client.close();
}

function sweepExpiredSessions(): void {
  const deadline = Date.now() - SESSION_IDLE_TTL_MS;
  for (const session of sessions.values()) {
    if (session.lastTouchedAt >= deadline) continue;
    void closeSession(session);
  }
}

function waitForEvent(
  session: CodexRealtimeSession,
  predicate: (event: CodexRealtimeEvent) => boolean,
  timeoutMs = START_EVENT_TIMEOUT_MS,
): Promise<CodexRealtimeEvent> {
  const existing = session.events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      const event = session.events.find(predicate);
      const error = session.events.find((candidate) => (
        candidate.method === 'thread/realtime/error'
      ));
      if (!event && !error) return;
      settled = true;
      clearTimeout(timer);
      session.waiters.delete(finish);
      if (error) {
        reject(new Error(
          typeof error.params.message === 'string'
            ? error.params.message
            : 'Codex realtime startup failed',
        ));
      } else {
        resolve(event as CodexRealtimeEvent);
      }
    };
    const timer = setTimeout(() => {
      settled = true;
      session.waiters.delete(finish);
      reject(new Error(`Codex realtime startup event timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    session.waiters.add(finish);
  });
}

async function startTextThread(
  session: CodexRealtimeSession,
  reason: string,
): Promise<void> {
  session.mode = 'text';
  session.transport = 'text';
  session.fallbackReason = reason;
  session.events = [];
  session.nextSeq = 1;
}

export async function startCodexRealtimeSession(
  input: StartCodexRealtimeSessionInput = {},
): Promise<StartCodexRealtimeSessionResult> {
  sweepExpiredSessions();
  const access = await resolveCodexRealtimeTransportAccess();
  if (!access.available || !access.capability.installation.binaryPath) {
    throw new CodexRealtimeTransportError(
      'codex_app_server_unavailable',
      access.reason,
      503,
    );
  }

  const id = sessionId();
  let session: CodexRealtimeSession | null = null;
  const client = new CodexAppServerClient({
    binaryPath: access.capability.installation.binaryPath,
    codexHome: path.dirname(access.capability.auth.authPath),
    onNotification: (notification) => {
      if (session) recordNotification(session, notification);
    },
    onExit: (detail) => {
      if (!session || session.closed) return;
      pushEvent(session, 'thread/realtime/closed', {
        threadId: session.threadId,
        reason: detail,
      });
      session.closed = true;
      sessions.delete(session.id);
    },
  });

  try {
    await client.initialize();
    const threadResult = record(await client.request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      developerInstructions: DEFAULT_INSTRUCTIONS,
    }));
    const thread = record(threadResult?.thread);
    const threadId = typeof thread?.id === 'string' ? thread.id : '';
    if (!threadId) {
      throw new Error('Codex app-server thread/start returned no thread id');
    }

    session = {
      id,
      threadId,
      mode: access.mode === 'codex-oauth' ? 'codex-oauth' : 'text',
      transport: access.mode === 'codex-oauth'
        ? (input.transport ?? (input.sdp ? 'webrtc' : 'websocket'))
        : 'text',
      client,
      events: [],
      nextSeq: 1,
      waiters: new Set(),
      lastTouchedAt: Date.now(),
      closed: false,
      fallbackReason: access.mode === 'text' ? access.reason : null,
    };
    sessions.set(id, session);

    let answerSdp: string | null = null;
    if (access.mode === 'codex-oauth') {
      const transport = session.transport as CodexRealtimeTransport;
      const startParams = buildCodexRealtimeStartParams({
        threadId,
        sdp: input.sdp,
        transport,
        outputModality: input.outputModality,
        prompt: input.prompt,
        model: input.model,
        voice: input.voice,
      });
      try {
        await client.request('thread/realtime/start', startParams);
        const ready = await waitForEvent(
          session,
          (event) => event.method === (
            transport === 'webrtc'
              ? 'thread/realtime/sdp'
              : 'thread/realtime/started'
          ),
        );
        if (transport === 'webrtc') {
          answerSdp = typeof ready.params.sdp === 'string' ? ready.params.sdp : null;
          if (!answerSdp) throw new Error('Codex realtime returned no SDP answer');
        }
      } catch (error) {
        if (input.allowTextFallback === false) throw error;
        await client.request('thread/realtime/stop', { threadId }, 2_000).catch(() => {});
        await startTextThread(
          session,
          `Connected Voice could not start (${messageFor(error)}); using text automatically.`,
        );
      }
    }

    return {
      sessionId: id,
      threadId,
      mode: session.mode,
      transport: session.transport,
      version: session.mode === 'codex-oauth' ? CODEX_REALTIME_VERSION : null,
      sdp: answerSdp,
      fallbackReason: session.fallbackReason,
      access,
    };
  } catch (error) {
    if (session) sessions.delete(session.id);
    await client.close();
    if (error instanceof CodexRealtimeTransportError) throw error;
    throw new CodexRealtimeTransportError(
      'codex_realtime_start_failed',
      messageFor(error),
      502,
    );
  }
}

export async function appendCodexRealtimeAudio(
  id: string,
  audio: CodexRealtimeAudioChunk,
): Promise<void> {
  const session = getSession(id);
  if (session.mode !== 'codex-oauth') {
    throw new CodexRealtimeTransportError(
      'audio_unavailable_in_text_fallback',
      'Audio is unavailable in the text fallback session.',
      409,
    );
  }
  await session.client.request('thread/realtime/appendAudio', {
    threadId: session.threadId,
    audio: {
      data: audio.data,
      sampleRate: audio.sampleRate,
      numChannels: audio.numChannels,
      samplesPerChannel: audio.samplesPerChannel ?? null,
      itemId: audio.itemId ?? null,
    },
  });
}

export async function appendCodexRealtimeText(
  id: string,
  text: string,
  role: 'user' | 'developer' | 'assistant' = 'user',
): Promise<void> {
  const session = getSession(id);
  if (session.mode === 'codex-oauth') {
    await session.client.request('thread/realtime/appendText', {
      threadId: session.threadId,
      text,
      role,
    });
    return;
  }
  if (role !== 'user') {
    throw new CodexRealtimeTransportError(
      'text_fallback_role_unsupported',
      'The text fallback accepts user messages only.',
      400,
    );
  }
  await session.client.request('turn/start', {
    threadId: session.threadId,
    input: [{ type: 'text', text, text_elements: [] }],
  });
}

export async function appendCodexRealtimeSpeech(
  id: string,
  text: string,
): Promise<void> {
  const session = getSession(id);
  if (session.mode === 'codex-oauth') {
    await session.client.request('thread/realtime/appendSpeech', {
      threadId: session.threadId,
      text,
    });
    return;
  }
  await appendCodexRealtimeText(id, text);
}

export async function pollCodexRealtimeEvents(
  id: string,
  since: number,
  timeoutMs: number,
): Promise<{ events: CodexRealtimeEvent[]; nextSince: number; mode: CodexRealtimeSessionMode }> {
  const session = getSession(id);
  const collect = () => session.events.filter((event) => event.seq > since);
  let events = collect();
  if (events.length === 0 && timeoutMs > 0) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        session.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, timeoutMs);
      session.waiters.add(wake);
    });
    events = collect();
  }
  return {
    events,
    nextSince: events.at(-1)?.seq ?? since,
    mode: session.mode,
  };
}

export async function stopCodexRealtimeSession(id: string): Promise<void> {
  const session = getSession(id);
  if (session.mode === 'codex-oauth') {
    await session.client.request(
      'thread/realtime/stop',
      { threadId: session.threadId },
      2_000,
    ).catch(() => {});
  }
  await closeSession(session);
}

/** Shutdown/test seam: release every child process without mutating user state. */
export async function closeAllCodexRealtimeSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map(closeSession));
}
