/**
 * Symon Agent Mode — tool-relay correlation + timeout primitives.
 *
 * The phone forwards each model `function_call` as a `symon-tool-call`; the Mac
 * executes it and returns a `symon-tool-result`. The model can PARALLEL-call, so
 * the relay must tolerate concurrent calls and correlate strictly by `callId`
 * (docs/symon-agent-mode.md §"Tool relay semantics"). This module is the pure,
 * unit-testable core of that bookkeeping — no WS, no fetch, no clock of its own.
 */

/** Per-call execution timeout. A late Mac-side result after this is dropped. */
export const TOOL_TIMEOUT_MS = 60_000;

export interface PendingToolCall {
  sessionId: string;
  callId: string;
  tool: string;
  startedAt: number;
}

export interface ToolResult {
  ok: boolean;
  /** JSON value handed back to the model; on failure `{ error, detail? }`. */
  result: unknown;
}

/** The `{ ok:false, result:{ error:"tool_timeout" } }` the contract mandates at 60s. */
export function toolTimeoutResult(): ToolResult {
  return { ok: false, result: { error: 'tool_timeout' } };
}

/** A structured failure result (never thrown — handed to the model as output). */
export function toolErrorResult(code: string, detail?: string): ToolResult {
  return { ok: false, result: detail ? { error: code, detail } : { error: code } };
}

/**
 * Derive `ok` from a raw `realtime_invoke_tool` return value the SAME way the
 * desk client does (realtime-client.ts): a value carrying an `error` key is a
 * tool failure, everything else is success. The relay never invents semantics.
 */
export function deriveOk(result: unknown): boolean {
  return !(result !== null && typeof result === 'object' && 'error' in (result as Record<string, unknown>));
}

/**
 * Tracks in-flight tool calls keyed by the model's opaque `callId`. Correlation
 * is strict: a result for an unknown/already-resolved callId returns null (the
 * caller drops it) rather than being mis-attributed to another call.
 */
export class ToolCallTracker {
  private readonly calls = new Map<string, PendingToolCall>();

  /** Register a call. Returns false if this callId is already in flight (dupe). */
  add(call: PendingToolCall): boolean {
    if (this.calls.has(call.callId)) return false;
    this.calls.set(call.callId, call);
    return true;
  }

  get(callId: string): PendingToolCall | undefined {
    return this.calls.get(callId);
  }

  has(callId: string): boolean {
    return this.calls.has(callId);
  }

  /** Resolve + remove a call by callId. Returns it, or null if unknown/duplicate. */
  resolve(callId: string): PendingToolCall | null {
    const call = this.calls.get(callId);
    if (!call) return null;
    this.calls.delete(callId);
    return call;
  }

  /** How many calls are still executing for a given session (for acting↔live). */
  inFlightForSession(sessionId: string): number {
    let n = 0;
    for (const call of this.calls.values()) if (call.sessionId === sessionId) n += 1;
    return n;
  }

  /** Remove + return calls whose deadline has passed (caller emits tool_timeout). */
  timedOut(now: number, ttlMs: number = TOOL_TIMEOUT_MS): PendingToolCall[] {
    const stale: PendingToolCall[] = [];
    for (const call of this.calls.values()) {
      if (now - call.startedAt > ttlMs) stale.push(call);
    }
    for (const call of stale) this.calls.delete(call.callId);
    return stale;
  }

  /** Drop + return every call for a session (session stop / preemption). */
  removeSession(sessionId: string): PendingToolCall[] {
    const removed: PendingToolCall[] = [];
    for (const call of this.calls.values()) {
      if (call.sessionId === sessionId) removed.push(call);
    }
    for (const call of removed) this.calls.delete(call.callId);
    return removed;
  }

  size(): number {
    return this.calls.size;
  }
}
