import 'server-only';

import path from 'node:path';

import { CodexAppServerClient } from '@/lib/codex/app-server-client';
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

const START_EVENT_TIMEOUT_MS = 12_000;
const SESSION_IDLE_TTL_MS = 10 * 60_000;
const MAX_EVENTS = 1_024;

interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
