/**
 * Agent Client Protocol (ACP) stdio client.
 *
 * ACP is the protocol Zed / VS Code / JetBrains use to drive AI coding agents
 * (agentclientprotocol.com — NOT MCP). o8 uses it as the generic orchestrator-
 * backend transport: one client → any ACP agent (Hermes now; openclaw acpx / Zed
 * later). This module owns the wire (spawn + JSON-RPC 2.0 over newline-delimited
 * JSON) and the `session/update` → `OrchestratorEvent` mapping. The backend
 * (`orchestrator-backends/acp.ts`) owns sessions / lifecycle on top of it.
 *
 * Wire facts verified against the published spec AND live `hermes acp` v0.17.0:
 *   - framing is NDJSON (one JSON-RPC object per line) — NOT Content-Length;
 *   - lifecycle: initialize → session/new → session/prompt; the prompt REQUEST's
 *     result carries `stopReason` and IS the end-of-turn signal;
 *   - streaming arrives as `session/update` notifications in between;
 *   - session/cancel is a NOTIFICATION (no id);
 *   - agents emit non-standard update variants (hermes: `usage_update`) — unknown
 *     variants are ignored, never fatal.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// ── ACP wire types (the subset o8 uses) ──

/** stdio MCP server entry for `session/new` — note `env` is an ARRAY of {name,value}. */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | string;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ACP_PROTOCOL_VERSION = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Extract the text from an ACP ContentBlock ({type:'text', text}) defensively. */
function contentText(content: unknown): string {
  const block = asRecord(content);
  if (block && typeof block.text === 'string') return block.text;
  // Some agents wrap tool output as ToolCallContent[] ({type:'content', content: ContentBlock}).
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const rec = asRecord(item);
        if (!rec) return '';
        if (typeof rec.text === 'string') return rec.text;
        return contentText(rec.content);
      })
      .join('');
  }
  return '';
}

/**
 * Map one ACP `session/update` payload (`update`) to an OrchestratorEvent, or
 * null when the variant has no o8 event (user echo, plan, command lists, the
 * hermes-specific `usage_update`, in-flight tool progress). PURE — unit-tested.
 */
export function mapAcpUpdate(update: unknown): OrchestratorEvent | null {
  const u = asRecord(update);
  if (!u) return null;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return { type: 'text', text: contentText(u.content) };
    case 'agent_thought_chunk':
      return { type: 'thinking', text: contentText(u.content) };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: str(u.toolCallId),
        name: str(u.title) ?? str(u.kind) ?? 'tool',
        input: u.rawInput ?? null,
      };
    case 'tool_call_update':
      // Only surface a tool RESULT on completion; in-progress ticks are skipped.
      if (u.status === 'completed') {
        return { type: 'tool_result', id: str(u.toolCallId), name: str(u.title) ?? '', output: contentText(u.content) };
      }
      return null;
    default:
      return null; // user_message_chunk · plan · available_commands_update · usage_update · current_mode_update · …
  }
}

/** Map a terminal stopReason to the o8 `done`/`error` event. */
export function mapStopReason(stopReason: AcpStopReason, sessionId: string | null): OrchestratorEvent {
  if (stopReason === 'refusal') {
    return { type: 'error', error: 'ACP agent refused the turn (no model/provider configured, or the request was declined).' };
  }
  return { type: 'done', sessionId, cost: null };
}

export interface AcpClientOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Called for every session/update notification's OrchestratorEvent (mapped). */
  onEvent?: (event: OrchestratorEvent) => void;
  /** Raw stderr lines from the agent (logs) — optional, for diagnostics. */
  onStderr?: (chunk: string) => void;
}

/**
 * A live ACP agent subprocess speaking JSON-RPC 2.0 over NDJSON stdio. One client
 * = one agent process = (typically) one ACP session, reused across turns.
 */
export class AcpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = '';
  private readonly onEvent?: (event: OrchestratorEvent) => void;
  private closed = false;

  constructor(opts: AcpClientOptions) {
    this.onEvent = opts.onEvent;
    this.proc = spawn(opts.command, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    if (opts.onStderr) this.proc.stderr?.on('data', (c: Buffer) => opts.onStderr!(c.toString('utf8')));
    this.proc.on('close', () => this.onClose());
    this.proc.on('error', (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown> | null;
      try {
        msg = asRecord(JSON.parse(line));
      } catch {
        continue; // non-JSON log line on stdout — ignore
      }
      if (!msg) continue;
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response to one of our requests (has a matching id).
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg))) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      const res = msg as unknown as JsonRpcResponse;
      if (res.error) entry.reject(new Error(`ACP error ${res.error.code}: ${res.error.message}`));
      else entry.resolve(res.result);
      return;
    }
    // session/update notification → mapped OrchestratorEvent.
    if (msg.method === 'session/update') {
      const params = asRecord(msg.params);
      const event = params ? mapAcpUpdate(params.update) : null;
      if (event && this.onEvent) this.onEvent(event);
    }
    // Agent→client requests (fs/read, permission prompts, …) are not handled in
    // v1 — Hermes runs with --accept-hooks so it doesn't block on them.
  }

  private onClose(): void {
    this.closed = true;
    this.failAll(new Error('ACP agent process exited'));
  }

  private failAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private write(obj: Record<string, unknown>): void {
    if (this.closed) throw new Error('ACP client is closed');
    this.proc.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  async initialize(clientName = 'o8', clientVersion = '0.1.0'): Promise<AcpInitializeResult> {
    const r = asRecord(await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: clientName, version: clientVersion },
    })) ?? {};
    return {
      protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : ACP_PROTOCOL_VERSION,
      agentCapabilities: asRecord(r.agentCapabilities) ?? undefined,
      agentInfo: (asRecord(r.agentInfo) ?? undefined) as AcpInitializeResult['agentInfo'],
      authMethods: (Array.isArray(r.authMethods) ? r.authMethods : undefined) as AcpInitializeResult['authMethods'],
    };
  }

  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<string> {
    const result = asRecord(await this.request('session/new', { cwd, mcpServers }));
    const sessionId = result ? str(result.sessionId) : null;
    if (!sessionId) throw new Error('ACP session/new returned no sessionId');
    return sessionId;
  }

  /** Run one prompt turn. Resolves with the stopReason when the agent finishes;
   *  streaming arrives via onEvent in between. */
  async prompt(sessionId: string, text: string): Promise<AcpStopReason> {
    const result = asRecord(await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }));
    return (result && str(result.stopReason)) || 'end_turn';
  }

  /** Abort the in-flight turn (notification — the agent ends it with stopReason 'cancelled'). */
  cancel(sessionId: string): void {
    if (!this.closed) {
      try {
        this.notify('session/cancel', { sessionId });
      } catch {
        /* already gone */
      }
    }
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  kill(): void {
    this.closed = true;
    try {
      this.proc.kill('SIGTERM');
    } catch {
      /* already dead */
    }
  }
}
