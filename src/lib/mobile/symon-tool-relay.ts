/**
 * Symon Agent Mode — tool-relay correlation + timeout primitives.
 *
 * The phone forwards each model `function_call` as a `symon-tool-call`; the Mac
 * executes it and returns a `symon-tool-result`. The model can PARALLEL-call, so
 * the relay must tolerate concurrent calls and correlate strictly by the
 * `(sessionId, callId)` pair
 * (docs/symon-agent-mode.md §"Tool relay semantics"). This module is the pure,
 * unit-testable core of that bookkeeping — no WS, no fetch, no clock of its own.
 */

/** Per-call execution timeout. A late Mac-side result after this is dropped. */
export const TOOL_TIMEOUT_MS = 60_000;
/** Final call/decision tombstones retained for idempotent phone retries. */
export const SYMON_REPLAY_TTL_MS = 5 * 60_000;

export type SymonProtocolVersion = 1 | 2;

export interface SymonConfirmationTarget {
  approvalId?: string;
  packetId?: string;
  laneId?: string;
  sessionKey?: string;
}

export interface SymonPendingConfirmation {
  sessionId: string;
  callId: string;
  confirmationId: string;
  taskId: string;
  tool: string;
  summary: string;
  expiresAt: number;
  target: SymonConfirmationTarget;
}

export type SymonConfirmationOutcome =
  | 'approved'
  | 'declined'
  | 'expired'
  | 'preempted'
  | 'duplicate';

export type SymonConfirmationResolution =
  | { status: 'resolved'; allow: boolean }
  | { status: 'already_resolved'; allow: boolean }
  | { status: 'expired' | 'preempted' | 'not_found' };

export function confirmationOutcomeFromResolution(
  resolution: SymonConfirmationResolution,
): Exclude<SymonConfirmationOutcome, 'duplicate'> | null {
  if (resolution.status === 'resolved' || resolution.status === 'already_resolved') {
    return resolution.allow ? 'approved' : 'declined';
  }
  if (resolution.status === 'expired' || resolution.status === 'preempted') return resolution.status;
  return null;
}

export type SymonToolPhase = 'running' | 'awaiting_confirmation' | 'executing';

export interface PendingToolCall {
  sessionId: string;
  callId: string;
  tool: string;
  startedAt: number;
  args?: Record<string, unknown>;
  protocolVersion?: SymonProtocolVersion;
  phase?: SymonToolPhase;
  confirmationId?: string;
}

export interface ToolResult {
  ok: boolean;
  /** JSON value handed back to the model; on failure `{ error, detail? }`. */
  result: unknown;
}

export interface SymonToolRelayResult extends ToolResult {
  confirmation?: SymonPendingConfirmation;
}

export interface SymonActionComplete {
  sessionId: string;
  callId: string;
  tool: string;
  status: 'accepted' | 'review' | 'done' | 'failed' | 'stopped';
  confirmationId?: string;
  taskId?: string;
  approvalId?: string;
  packetId?: string;
  laneId?: string;
  sessionKey?: string;
  ts: string;
}

export interface SymonLaneLifecycleInput {
  laneId: string;
  packetId: string | null;
  repoPath: string;
  status:
    | 'idle'
    | 'launching'
    | 'running'
    | 'paused'
    | 'awaiting_input'
    | 'awaiting_orchestrator'
    | 'awaiting_human'
    | 'recovering'
    | 'reviewing'
    | 'merging'
    | 'failed'
    | 'completed'
    | 'archived';
}

export interface CompletedToolCall {
  call: PendingToolCall;
  outcome: ToolResult;
  action: SymonActionComplete;
  completedAt: number;
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

export function parseSymonPendingConfirmation(
  value: unknown,
  expected: { sessionId: string; callId: string; tool: string },
): SymonPendingConfirmation | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.sessionId !== expected.sessionId
    || record.callId !== expected.callId
    || record.tool !== expected.tool
    || typeof record.confirmationId !== 'string'
    || record.confirmationId.length === 0
    || typeof record.taskId !== 'string'
    || typeof record.summary !== 'string'
    || typeof record.expiresAt !== 'number'
    || !Number.isFinite(record.expiresAt)) {
    return null;
  }
  const rawTarget = record.target && typeof record.target === 'object'
    ? record.target as Record<string, unknown>
    : {};
  const target: SymonConfirmationTarget = {};
  for (const key of ['approvalId', 'packetId', 'laneId', 'sessionKey'] as const) {
    const targetValue = rawTarget[key];
    if (typeof targetValue === 'string' && targetValue.length > 0) target[key] = targetValue;
  }
  return {
    sessionId: expected.sessionId,
    callId: expected.callId,
    confirmationId: record.confirmationId,
    taskId: record.taskId,
    tool: expected.tool,
    summary: record.summary,
    expiresAt: record.expiresAt,
    target,
  };
}

function toolCallKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

function confirmationKey(sessionId: string, callId: string, confirmationId: string): string {
  return `${toolCallKey(sessionId, callId)}\u0000${confirmationId}`;
}

function stringValue(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function buildSymonActionComplete(
  call: PendingToolCall,
  outcome: ToolResult,
  completedAt: number,
): SymonActionComplete {
  const record = outcome.result && typeof outcome.result === 'object'
    ? outcome.result as Record<string, unknown>
    : {};
  const approvalId = stringValue(record, ['approvalId', 'approval_id']);
  const packetId = stringValue(record, ['packetId', 'packet_id']);
  const laneId = stringValue(record, ['laneId', 'lane_id']);
  const sessionKey = stringValue(record, ['sessionKey', 'session_key', 'surfaceId', 'surface_id']);
  const taskId = stringValue(record, ['taskId', 'task_id']);
  const declined = record.declined_by_user === true
    || record.error === 'confirmation_declined'
    || record.error === 'session_stopped'
    || record.error === 'session_preempted';
  const asyncAction = new Set([
    'o8_dispatch',
    'o8_delegate',
    'o8_packet_steer',
    'o8_agent_task',
    'o8_packet_rerun',
    'o8_packet_reset',
  ]).has(call.tool);
  const status = !outcome.ok
    ? (declined ? 'stopped' : 'failed')
    : approvalId
      ? 'review'
      : call.tool === 'o8_stop_agent'
        ? 'stopped'
        : asyncAction
          ? 'accepted'
          : 'done';

  return {
    sessionId: call.sessionId,
    callId: call.callId,
    tool: call.tool,
    status,
    ...(call.confirmationId ? { confirmationId: call.confirmationId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(packetId ? { packetId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ts: new Date(completedAt).toISOString(),
  };
}

/**
 * Tracks in-flight tool calls keyed by the session plus the model's opaque
 * `callId`. Correlation is strict: a result for an unknown/already-resolved pair
 * returns null rather than being mis-attributed to another call.
 */
export class ToolCallTracker {
  private readonly calls = new Map<string, PendingToolCall>();
  private readonly completed = new Map<string, CompletedToolCall>();

  private pruneCompleted(now: number): void {
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > SYMON_REPLAY_TTL_MS) this.completed.delete(key);
    }
  }

  /** Register a call. Returns false when this session/call pair is active or replayable. */
  add(call: PendingToolCall): boolean {
    this.pruneCompleted(call.startedAt);
    const key = toolCallKey(call.sessionId, call.callId);
    if (this.calls.has(key) || this.completed.has(key)) return false;
    this.calls.set(key, { ...call, phase: call.phase ?? 'running' });
    return true;
  }

  get(sessionId: string, callId: string): PendingToolCall | undefined {
    return this.calls.get(toolCallKey(sessionId, callId));
  }

  has(sessionId: string, callId: string): boolean {
    return this.calls.has(toolCallKey(sessionId, callId));
  }

  markAwaitingConfirmation(
    sessionId: string,
    callId: string,
    confirmationId: string,
  ): PendingToolCall | null {
    const call = this.get(sessionId, callId);
    if (!call) return null;
    call.phase = 'awaiting_confirmation';
    call.confirmationId = confirmationId;
    return call;
  }

  markExecuting(sessionId: string, callId: string, now: number): PendingToolCall | null {
    const call = this.get(sessionId, callId);
    if (!call) return null;
    call.phase = 'executing';
    call.startedAt = now;
    return call;
  }

  /** Resolve + remove an active call without caching a result. */
  resolve(sessionId: string, callId: string): PendingToolCall | null {
    const key = toolCallKey(sessionId, callId);
    const call = this.calls.get(key);
    if (!call) return null;
    this.calls.delete(key);
    return call;
  }

  complete(
    sessionId: string,
    callId: string,
    outcome: ToolResult,
    completedAt: number,
  ): CompletedToolCall | null {
    const call = this.resolve(sessionId, callId);
    if (!call) return null;
    const completed = {
      call,
      outcome,
      action: buildSymonActionComplete(call, outcome, completedAt),
      completedAt,
    };
    this.completed.set(toolCallKey(sessionId, callId), completed);
    this.pruneCompleted(completedAt);
    return completed;
  }

  replay(sessionId: string, callId: string, now: number): CompletedToolCall | null {
    this.pruneCompleted(now);
    return this.completed.get(toolCallKey(sessionId, callId)) ?? null;
  }

  /** How many calls are still executing for a given session (for acting↔live). */
  inFlightForSession(sessionId: string): number {
    let n = 0;
    for (const call of this.calls.values()) if (call.sessionId === sessionId) n += 1;
    return n;
  }

  /** Return expired calls; the caller completes/caches each terminal timeout. */
  timedOut(now: number, ttlMs: number = TOOL_TIMEOUT_MS): PendingToolCall[] {
    const stale: PendingToolCall[] = [];
    for (const call of this.calls.values()) {
      if (call.phase !== 'awaiting_confirmation' && now - call.startedAt > ttlMs) stale.push(call);
    }
    return stale;
  }

  /** Drop + return every call for a session (session stop / preemption). */
  removeSession(sessionId: string): PendingToolCall[] {
    const removed: PendingToolCall[] = [];
    for (const call of this.calls.values()) {
      if (call.sessionId === sessionId) removed.push(call);
    }
    for (const call of removed) this.calls.delete(toolCallKey(call.sessionId, call.callId));
    return removed;
  }

  abortSession(sessionId: string, error: 'session_stopped' | 'session_preempted', now: number): CompletedToolCall[] {
    const completed: CompletedToolCall[] = [];
    for (const call of Array.from(this.calls.values())) {
      if (call.sessionId !== sessionId) continue;
      const outcome: ToolResult = { ok: false, result: { error } };
      this.calls.delete(toolCallKey(call.sessionId, call.callId));
      const entry = {
        call,
        outcome,
        action: buildSymonActionComplete(call, outcome, now),
        completedAt: now,
      };
      this.completed.set(toolCallKey(call.sessionId, call.callId), entry);
      completed.push(entry);
    }
    this.pruneCompleted(now);
    return completed;
  }

  size(): number {
    return this.calls.size;
  }
}

const TRACKED_ASYNC_CODE_TOOLS = new Set([
  'o8_dispatch',
  'o8_packet_steer',
  'o8_agent_task',
  'o8_packet_rerun',
  'o8_packet_reset',
]);

interface TrackedAsyncAction {
  action: SymonActionComplete;
  repoPath: string;
  registeredAt: number;
}

/**
 * Carries a confirmed Code mutation from its immediate acceptance to the lane
 * transition that represents a useful terminal result for the phone.
 */
export class SymonAsyncActionTracker {
  private readonly actions = new Map<string, TrackedAsyncAction>();

  register(action: SymonActionComplete, repoPath: string, now: number): boolean {
    if (action.status !== 'accepted' || !TRACKED_ASYNC_CODE_TOOLS.has(action.tool)) return false;
    if (!repoPath || (!action.laneId && !action.packetId)) return false;
    const key = toolCallKey(action.sessionId, action.callId);
    this.actions.set(key, { action: { ...action }, repoPath, registeredAt: now });
    return true;
  }

  settleLane(event: SymonLaneLifecycleInput, now: number): SymonActionComplete[] {
    const terminalStatus = event.status === 'reviewing'
      || event.status === 'awaiting_input'
      || event.status === 'awaiting_orchestrator'
      || event.status === 'awaiting_human'
      ? 'review'
      : event.status === 'completed'
        ? 'done'
        : event.status === 'failed' || event.status === 'recovering'
          ? 'failed'
          : event.status === 'paused' || event.status === 'archived'
            ? 'stopped'
            : null;
    if (!terminalStatus) return [];

    const settled: SymonActionComplete[] = [];
    for (const [key, tracked] of this.actions) {
      const sameTarget = tracked.repoPath === event.repoPath
        && (tracked.action.laneId === event.laneId
          || (!tracked.action.laneId
            && Boolean(tracked.action.packetId)
            && tracked.action.packetId === event.packetId));
      if (!sameTarget) continue;
      this.actions.delete(key);
      settled.push({ ...tracked.action, status: terminalStatus, ts: new Date(now).toISOString() });
    }
    return settled;
  }

  removeSession(sessionId: string): void {
    for (const [key, tracked] of this.actions) {
      if (tracked.action.sessionId === sessionId) this.actions.delete(key);
    }
  }

  prune(now: number, ttlMs = 24 * 60 * 60 * 1_000): void {
    for (const [key, tracked] of this.actions) {
      if (now - tracked.registeredAt > ttlMs) this.actions.delete(key);
    }
  }

  size(): number {
    return this.actions.size;
  }
}

interface ConfirmationRecord extends SymonPendingConfirmation {
  decisionAllow?: boolean;
  clientMutationId?: string;
  outcome?: Exclude<SymonConfirmationOutcome, 'duplicate'>;
  settledAt?: number;
}

function confirmationSnapshot(record: ConfirmationRecord): SymonPendingConfirmation {
  return {
    sessionId: record.sessionId,
    callId: record.callId,
    confirmationId: record.confirmationId,
    taskId: record.taskId,
    tool: record.tool,
    summary: record.summary,
    expiresAt: record.expiresAt,
    target: { ...record.target },
  };
}

export type ConfirmationClaim =
  | { kind: 'claimed'; confirmation: SymonPendingConfirmation; allow: boolean; forcedOutcome?: 'expired' }
  | { kind: 'in_flight'; confirmation: SymonPendingConfirmation }
  | {
      kind: 'replay';
      confirmation: SymonPendingConfirmation;
      outcome: Exclude<SymonConfirmationOutcome, 'duplicate'>;
    }
  | { kind: 'missing' };

/** Pure confirmation decision/tombstone state; Rust remains the execution authority. */
export class SymonConfirmationTracker {
  private readonly records = new Map<string, ConfirmationRecord>();

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      const settledAt = record.settledAt ?? record.expiresAt;
      if (now - settledAt > SYMON_REPLAY_TTL_MS) this.records.delete(key);
    }
  }

  register(confirmation: SymonPendingConfirmation, now: number): boolean {
    this.prune(now);
    const key = confirmationKey(
      confirmation.sessionId,
      confirmation.callId,
      confirmation.confirmationId,
    );
    if (this.records.has(key)) return false;
    this.records.set(key, { ...confirmation });
    return true;
  }

  get(sessionId: string, callId: string, confirmationId: string): SymonPendingConfirmation | null {
    const record = this.records.get(confirmationKey(sessionId, callId, confirmationId));
    return record ? confirmationSnapshot(record) : null;
  }

  claim(input: {
    sessionId: string;
    callId: string;
    confirmationId: string;
    allow: boolean;
    clientMutationId: string;
    now: number;
  }): ConfirmationClaim {
    this.prune(input.now);
    const record = this.records.get(confirmationKey(input.sessionId, input.callId, input.confirmationId));
    if (!record) return { kind: 'missing' };
    if (record.outcome) {
      return { kind: 'replay', confirmation: confirmationSnapshot(record), outcome: record.outcome };
    }
    if (record.decisionAllow !== undefined) {
      return { kind: 'in_flight', confirmation: confirmationSnapshot(record) };
    }
    const expired = input.now >= record.expiresAt;
    record.decisionAllow = expired ? false : input.allow;
    record.clientMutationId = input.clientMutationId;
    return {
      kind: 'claimed',
      confirmation: confirmationSnapshot(record),
      allow: record.decisionAllow,
      ...(expired ? { forcedOutcome: 'expired' as const } : {}),
    };
  }

  settle(
    sessionId: string,
    callId: string,
    confirmationId: string,
    outcome: Exclude<SymonConfirmationOutcome, 'duplicate'>,
    now: number,
  ): SymonPendingConfirmation | null {
    const record = this.records.get(confirmationKey(sessionId, callId, confirmationId));
    if (!record) return null;
    record.outcome = outcome;
    record.settledAt = now;
    return confirmationSnapshot(record);
  }

  release(sessionId: string, callId: string, confirmationId: string): boolean {
    const record = this.records.get(confirmationKey(sessionId, callId, confirmationId));
    if (!record || record.outcome) return false;
    record.decisionAllow = undefined;
    record.clientMutationId = undefined;
    return true;
  }

  expire(now: number): SymonPendingConfirmation[] {
    const expired: SymonPendingConfirmation[] = [];
    for (const record of this.records.values()) {
      if (!record.outcome && record.decisionAllow === undefined && now >= record.expiresAt) {
        record.decisionAllow = false;
        expired.push(confirmationSnapshot(record));
      }
    }
    return expired;
  }

  preemptSession(sessionId: string): SymonPendingConfirmation[] {
    const preempted: SymonPendingConfirmation[] = [];
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && !record.outcome) {
        if (record.decisionAllow === undefined) record.decisionAllow = false;
        preempted.push(confirmationSnapshot(record));
      }
    }
    return preempted;
  }
}
