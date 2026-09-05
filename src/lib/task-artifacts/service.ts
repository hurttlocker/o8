import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import { git } from '@/lib/lane/worktree-merge-git';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { steerPacket } from '@/lib/orchestrator/operator-mission-service';
import { normalizeDeclaredActions, validateActionPayload } from './schema-validate';
import {
  acceptedActionStats,
  acceptedNonceExists,
  getTaskArtifactActionById,
  getTaskArtifactById,
  insertTaskArtifact,
  insertTaskArtifactAction,
  lastTaskArtifactAction,
  listTaskArtifactActions,
  listTaskArtifactsByPacket,
  listTaskArtifactsByThread,
  TaskArtifactNonceReplayError,
  transitionTaskArtifactActionDelivery,
  updateTaskArtifactState,
} from './store';
import {
  ORCHESTRATOR_THREAD_ID_PATTERN,
  TASK_ARTIFACT_LIMITS,
  TASK_ARTIFACT_NONCE_PATTERN,
  TASK_ARTIFACT_SCHEMA_VERSION,
  type TaskArtifactActionRecord,
  type TaskArtifactActionStamp,
  type TaskArtifactCreator,
  type TaskArtifactHeadPolicy,
  type TaskArtifactRecord,
  type TaskArtifactTarget,
  type TaskArtifactView,
  type TaskArtifactWritability,
} from './types';

const LOG = '[task-artifacts]';

export class TaskArtifactError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(message);
    this.name = 'TaskArtifactError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable serialization so the payload hash is the same for the same values. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (seen.has(v)) throw new TaskArtifactError('invalid_payload', 'payload contains a cycle', 400);
      seen.add(v);
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, walk((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

async function readHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(cwd, ['rev-parse', 'HEAD'], { timeout: 5_000 });
    const head = stdout.trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function targetsMatch(a: TaskArtifactTarget, b: Partial<TaskArtifactTarget>): boolean {
  return a.kind === b.kind
    && a.repoPath === b.repoPath
    && (a.threadId ?? null) === (b.threadId ?? null)
    && (a.packetId ?? null) === (b.packetId ?? null);
}

function sameTargetIdentity(a: TaskArtifactTarget): TaskArtifactTarget {
  return { kind: a.kind, repoPath: a.repoPath, threadId: a.threadId, packetId: a.packetId, laneId: a.laneId, sessionKey: a.sessionKey };
}

// ── Creation ────────────────────────────────────────────────────────────────

export interface CreateTaskArtifactInput {
  title: unknown;
  html: unknown;
  actions: unknown;
  headPolicy?: unknown;
  /** Operator-created artifacts name one of these; workers are pinned to their packet. */
  threadId?: unknown;
  packetId?: unknown;
  repoPath?: unknown;
}

export async function createTaskArtifact(input: CreateTaskArtifactInput, ctx: RequestPrincipalContext): Promise<TaskArtifactRecord> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > TASK_ARTIFACT_LIMITS.titleMaxChars) {
    throw new TaskArtifactError('invalid_request', `title is required (max ${TASK_ARTIFACT_LIMITS.titleMaxChars} chars).`, 400);
  }
  const html = typeof input.html === 'string' ? input.html : '';
  if (!html.trim()) throw new TaskArtifactError('invalid_request', 'html is required.', 400);
  if (utf8Bytes(html) > TASK_ARTIFACT_LIMITS.htmlMaxBytes) {
    throw new TaskArtifactError('html_too_large', `html exceeds ${TASK_ARTIFACT_LIMITS.htmlMaxBytes} bytes.`, 413);
  }
  const actions = normalizeDeclaredActions(input.actions);
  if (!actions.ok) throw new TaskArtifactError('invalid_actions', 'Declared actions are invalid.', 400, actions.errors);
  const headPolicy: TaskArtifactHeadPolicy = input.headPolicy === 'any' ? 'any' : 'pinned';

  let target: TaskArtifactTarget;
  let createdBy: TaskArtifactCreator;
  let headCwd: string;

  const requestedPacketId = typeof input.packetId === 'string' ? input.packetId.trim() : '';
  const requestedThreadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
  const requestedRepoPath = typeof input.repoPath === 'string' ? input.repoPath.trim() : '';

  if (ctx.role === 'worker') {
    if (!ctx.packetId) throw new TaskArtifactError('forbidden', 'A worker must present a packet-bound token to create an artifact.', 403);
    if (requestedPacketId && requestedPacketId !== ctx.packetId) {
      throw new TaskArtifactError('forbidden', 'A worker may only attach artifacts to its own packet.', 403);
    }
    if (requestedThreadId) throw new TaskArtifactError('forbidden', 'A worker may not attach artifacts to a thread.', 403);
    const lane = findLaneByPacket(ctx.packetId);
    if (!lane) throw new TaskArtifactError('packet_not_found', `No lane for packet ${ctx.packetId}.`, 404);
    target = { kind: 'packet', repoPath: lane.repoPath, threadId: null, packetId: ctx.packetId, laneId: lane.id, sessionKey: lane.sessionKey ?? null };
    createdBy = 'worker';
    headCwd = lane.worktreePath ?? lane.repoPath;
  } else if (ctx.role === 'operator' || ctx.role === 'device') {
    if (requestedPacketId && requestedThreadId) {
      throw new TaskArtifactError('invalid_request', 'Name either a packetId or a threadId, not both.', 400);
    }
    if (requestedPacketId) {
      const lane = findLaneByPacket(requestedPacketId);
      if (!lane) throw new TaskArtifactError('packet_not_found', `No lane for packet ${requestedPacketId}.`, 404);
      target = { kind: 'packet', repoPath: lane.repoPath, threadId: null, packetId: requestedPacketId, laneId: lane.id, sessionKey: lane.sessionKey ?? null };
      headCwd = lane.worktreePath ?? lane.repoPath;
    } else {
      if (!ORCHESTRATOR_THREAD_ID_PATTERN.test(requestedThreadId)) {
        throw new TaskArtifactError('invalid_request', 'threadId must be an orchestrator thread id (thoughts-…).', 400);
      }
      if (!requestedRepoPath) throw new TaskArtifactError('invalid_request', 'repoPath is required for a thread target.', 400);
      target = { kind: 'thread', repoPath: requestedRepoPath, threadId: requestedThreadId, packetId: null, laneId: null, sessionKey: null };
      headCwd = requestedRepoPath;
    }
    createdBy = 'orchestrator';
  } else {
    throw new TaskArtifactError('unauthorized', 'Creating a task artifact requires the operator credential or a packet worker token.', 401);
  }

  const originHead = await readHead(headCwd);
  const createdAt = nowIso();
  const record: TaskArtifactRecord = {
    id: `tart-${randomUUID()}`,
    schemaVersion: TASK_ARTIFACT_SCHEMA_VERSION,
    title,
    html,
    target,
    originHead,
    headPolicy,
    actions: actions.actions,
    state: 'live',
    stateReason: null,
    createdBy,
    createdAt,
    updatedAt: createdAt,
  };
  insertTaskArtifact(record);
  if (target.laneId) {
    recordLaneEvent(target.laneId, 'task_artifact_created', createdBy === 'worker' ? 'system' : 'orchestrator', {
      artifactId: record.id,
      title,
      actions: actions.actions.map((a) => a.name),
      originHead,
      headPolicy,
    });
  }
  console.log(`${LOG} created ${record.id} (${target.kind} ${target.threadId ?? target.packetId}) by ${createdBy}`);
  return record;
}

// ── Reads + writability ─────────────────────────────────────────────────────

async function evaluateWritability(record: TaskArtifactRecord): Promise<TaskArtifactWritability> {
  if (record.state !== 'live') {
    return { writable: false, reason: record.stateReason ?? `artifact is ${record.state}`, currentHead: null };
  }
  let headCwd = record.target.repoPath;
  if (record.target.kind === 'packet') {
    const lane = record.target.laneId ? getLane(record.target.laneId) : null;
    if (!lane) return { writable: false, reason: 'The packet lane no longer exists.', currentHead: null };
    if (isLaneTerminal(lane.status)) return { writable: false, reason: `The packet is ${lane.status}.`, currentHead: null };
    if (!lane.sessionKey) return { writable: false, reason: 'The packet has no steerable session.', currentHead: null };
    if (record.target.sessionKey && lane.sessionKey !== record.target.sessionKey) {
      return { writable: false, reason: 'The packet session changed since this artifact was created.', currentHead: null };
    }
    headCwd = lane.worktreePath ?? lane.repoPath;
  } else {
    const thread = record.target.threadId ? readPersistedLlmChat(record.target.threadId) : null;
    if (!thread) return { writable: false, reason: 'The thread that requested this artifact no longer exists.', currentHead: null };
  }
  const currentHead = await readHead(headCwd);
  if (record.headPolicy === 'pinned' && record.originHead && currentHead && currentHead !== record.originHead) {
    return {
      writable: false,
      reason: `HEAD moved from ${record.originHead.slice(0, 7)} to ${currentHead.slice(0, 7)} since this artifact was created.`,
      currentHead,
    };
  }
  return { writable: true, reason: null, currentHead };
}

async function toView(record: TaskArtifactRecord, includeHtml: boolean): Promise<TaskArtifactView> {
  const writability = await evaluateWritability(record);
  const stats = acceptedActionStats(record.id);
  const { html, ...rest } = record;
  return {
    artifact: includeHtml ? { ...rest, html } : rest,
    writability,
    lastAction: lastTaskArtifactAction(record.id),
    acceptedActionCount: stats.count,
  };
}

export async function getTaskArtifactView(id: string, options: { includeHtml?: boolean } = {}): Promise<TaskArtifactView | null> {
  const record = getTaskArtifactById(id);
  if (!record) return null;
  return toView(record, options.includeHtml ?? true);
}

export async function listTaskArtifactViews(query: { repoPath?: string; threadId?: string; packetId?: string }): Promise<TaskArtifactView[]> {
  let records: TaskArtifactRecord[] = [];
  if (query.packetId) records = listTaskArtifactsByPacket(query.packetId);
  else if (query.threadId && query.repoPath) records = listTaskArtifactsByThread(query.repoPath, query.threadId);
  return Promise.all(records.map((record) => toView(record, false)));
}

export function listTaskArtifactActionReceipts(id: string): TaskArtifactActionRecord[] {
  return listTaskArtifactActions(id);
}

// ── Submission ──────────────────────────────────────────────────────────────

export interface SubmitTaskArtifactActionInput {
  action: unknown;
  payload: unknown;
  nonce: unknown;
  target: unknown;
  actor: string;
}

export type SubmitTaskArtifactActionResult =
  | {
      accepted: true;
      action: TaskArtifactActionRecord;
      /** Packet targets are delivered here; thread targets ride the operator's own turn. */
      deliverVia: 'packet' | 'thread';
      wireMessage: string;
      displayMessage: string;
    }
  | { accepted: false; code: string; reason: string; action: TaskArtifactActionRecord | null };

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'empty payload';
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows.length : null;
  const fields = Object.keys(record).filter((k) => k !== 'rows').length;
  const parts: string[] = [];
  if (fields > 0) parts.push(`${fields} field${fields === 1 ? '' : 's'}`);
  if (rows !== null) parts.push(`${rows} row${rows === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'empty payload';
}

/** The exact text delivered to the originating session. Summary first, then the payload verbatim. */
export function composeActionMessage(record: TaskArtifactRecord, action: string, payload: unknown, actionId: string): { wireMessage: string; displayMessage: string } {
  const summary = payloadSummary(payload);
  const json = JSON.stringify(payload, null, 2);
  const wireMessage = [
    `Task artifact "${record.title}" (${record.id}) returned action "${action}" from the operator (${summary}). Receipt ${actionId}.`,
    'Exact payload:',
    '```json',
    json,
    '```',
  ].join('\n');
  const displayMessage = `Sent "${record.title}" · ${action} (${summary})`;
  return { wireMessage, displayMessage };
}

function reject(record: TaskArtifactRecord, input: { action: string; nonce: string; payload: unknown; target: TaskArtifactTarget; actor: string }, code: string, reason: string): SubmitTaskArtifactActionResult {
  const createdAt = nowIso();
  const row: TaskArtifactActionRecord = {
    id: `tact-${randomUUID()}`,
    artifactId: record.id,
    action: input.action,
    nonce: input.nonce,
    payloadHash: sha256(safeCanonical(input.payload)),
    payload: input.payload,
    target: input.target,
    actor: input.actor,
    delivery: 'rejected',
    deliveryNote: `${code}: ${reason}`,
    createdAt,
    deliveredAt: null,
  };
  insertTaskArtifactAction(row);
  if (record.target.laneId) {
    recordLaneEvent(record.target.laneId, 'task_artifact_action', 'user', {
      artifactId: record.id, actionId: row.id, action: row.action, payloadHash: row.payloadHash, actor: row.actor, delivery: 'rejected', note: row.deliveryNote,
    });
  }
  console.warn(`${LOG} rejected ${row.id} on ${record.id}: ${code} (${reason})`);
  return { accepted: false, code, reason, action: row };
}

function safeCanonical(payload: unknown): string {
  try { return canonicalJson(payload); } catch { return JSON.stringify(String(payload)); }
}

export async function submitTaskArtifactAction(id: string, input: SubmitTaskArtifactActionInput): Promise<SubmitTaskArtifactActionResult> {
  const record = getTaskArtifactById(id);
  if (!record) throw new TaskArtifactError('not_found', `Task artifact ${id} not found.`, 404);

  const action = typeof input.action === 'string' ? input.action : '';
  const nonce = typeof input.nonce === 'string' ? input.nonce : '';
  if (!TASK_ARTIFACT_NONCE_PATTERN.test(nonce)) {
    throw new TaskArtifactError('invalid_request', 'nonce is required (8–128 url-safe characters).', 400);
  }
  const target = input.target && typeof input.target === 'object' ? input.target as Partial<TaskArtifactTarget> : null;
  if (!target || (target.kind !== 'thread' && target.kind !== 'packet') || typeof target.repoPath !== 'string') {
    throw new TaskArtifactError('invalid_request', 'target must name the kind and repoPath the artifact was created for.', 400);
  }
  const requestedTarget: TaskArtifactTarget = {
    kind: target.kind,
    repoPath: target.repoPath,
    threadId: typeof target.threadId === 'string' ? target.threadId : null,
    packetId: typeof target.packetId === 'string' ? target.packetId : null,
    laneId: typeof target.laneId === 'string' ? target.laneId : null,
    sessionKey: typeof target.sessionKey === 'string' ? target.sessionKey : null,
  };
  const base = { action, nonce, payload: input.payload, target: requestedTarget, actor: input.actor };

  // Order matters: identity first, then liveness, then the payload contract,
  // then replay and rate. Every refusal past this point is a receipt.
  if (!targetsMatch(record.target, requestedTarget)) {
    return reject(record, base, 'target_mismatch', 'The submission named a different target than the artifact was created for.');
  }
  const writability = await evaluateWritability(record);
  if (!writability.writable) {
    return reject(record, base, 'read_only', writability.reason ?? 'artifact is read-only');
  }
  const declared = record.actions.find((a) => a.name === action);
  if (!declared) return reject(record, base, 'undeclared_action', `Action "${action || '(empty)'}" was not declared by this artifact.`);
  let serialized: string;
  try {
    serialized = canonicalJson(input.payload);
  } catch (error) {
    return reject(record, base, 'invalid_payload', error instanceof Error ? error.message : 'payload is not serializable');
  }
  if (utf8Bytes(serialized) > TASK_ARTIFACT_LIMITS.payloadMaxBytes) {
    return reject(record, base, 'payload_too_large', `Payload exceeds ${TASK_ARTIFACT_LIMITS.payloadMaxBytes} bytes.`);
  }
  const validation = validateActionPayload(declared.schema, input.payload);
  if (!validation.ok) return reject(record, base, 'schema_violation', validation.errors.slice(0, 8).join('; '));
  if (acceptedNonceExists(record.id, nonce)) {
    return reject(record, base, 'replayed', 'This submission was already accepted once.');
  }
  const stats = acceptedActionStats(record.id);
  if (stats.count >= TASK_ARTIFACT_LIMITS.maxAcceptedActions) {
    updateTaskArtifactState(record.id, 'suspended', `Reached ${TASK_ARTIFACT_LIMITS.maxAcceptedActions} accepted actions.`, nowIso());
    return reject(record, base, 'suspended', `The artifact reached its ${TASK_ARTIFACT_LIMITS.maxAcceptedActions}-action limit and was suspended.`);
  }
  if (stats.lastAcceptedAt && Date.now() - Date.parse(stats.lastAcceptedAt) < TASK_ARTIFACT_LIMITS.minActionIntervalMs) {
    return reject(record, base, 'rate_limited', `Wait ${TASK_ARTIFACT_LIMITS.minActionIntervalMs / 1000}s between submissions.`);
  }

  const createdAt = nowIso();
  const row: TaskArtifactActionRecord = {
    id: `tact-${randomUUID()}`,
    artifactId: record.id,
    action,
    nonce,
    payloadHash: sha256(serialized),
    payload: input.payload,
    target: sameTargetIdentity(record.target),
    actor: input.actor,
    delivery: 'accepted',
    deliveryNote: null,
    createdAt,
    deliveredAt: null,
  };
  try {
    insertTaskArtifactAction(row);
  } catch (error) {
    if (error instanceof TaskArtifactNonceReplayError) {
      return reject(record, base, 'replayed', 'This submission was already accepted once.');
    }
    throw error;
  }
  const message = composeActionMessage(record, action, input.payload, row.id);

  if (record.target.kind === 'packet' && record.target.packetId) {
    try {
      const steered = await steerPacket({ packetId: record.target.packetId, message: message.wireMessage, source: 'operator', clientMutationId: row.id });
      const deliveredAt = nowIso();
      transitionTaskArtifactActionDelivery({ actionId: row.id, from: 'accepted', to: 'delivered', note: steered.note, deliveredAt });
      row.delivery = 'delivered'; row.deliveryNote = steered.note; row.deliveredAt = deliveredAt;
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      transitionTaskArtifactActionDelivery({ actionId: row.id, from: 'accepted', to: 'failed', note, deliveredAt: null });
      row.delivery = 'failed'; row.deliveryNote = note;
    }
    if (record.target.laneId) {
      recordLaneEvent(record.target.laneId, 'task_artifact_action', 'user', {
        artifactId: record.id, actionId: row.id, action, payloadHash: row.payloadHash, actor: row.actor, delivery: row.delivery, note: row.deliveryNote,
      });
    }
    console.log(`${LOG} ${row.delivery} ${row.id} on ${record.id} → packet ${record.target.packetId}`);
    return { accepted: true, action: row, deliverVia: 'packet', ...message };
  }

  console.log(`${LOG} accepted ${row.id} on ${record.id} → thread ${record.target.threadId} (client delivers)`);
  return { accepted: true, action: row, deliverVia: 'thread', ...message };
}

// ── Thread delivery mark (called by the realtime server) ────────────────────

/**
 * The ws-server calls this when a thread turn stamped with an action arrives.
 * It proves the action is still `accepted` and that the turn is landing on the
 * exact thread the artifact was created for, then marks it delivered once.
 * Any other answer means the turn must not be run.
 */
export function markThreadActionDelivered(stamp: TaskArtifactActionStamp, turn: { repoPath: string; threadId: string | null }): { ok: true } | { ok: false; reason: string } {
  const action = getTaskArtifactActionById(stamp.actionId);
  if (!action || action.artifactId !== stamp.artifactId) return { ok: false, reason: 'unknown task artifact action' };
  const record = getTaskArtifactById(stamp.artifactId);
  if (!record) return { ok: false, reason: 'unknown task artifact' };
  if (record.target.kind !== 'thread') return { ok: false, reason: 'artifact does not target a thread' };
  if (record.target.repoPath !== turn.repoPath || record.target.threadId !== turn.threadId) {
    return { ok: false, reason: 'turn is not landing on the thread this artifact was created for' };
  }
  if (action.delivery !== 'accepted') return { ok: false, reason: `action is already ${action.delivery}` };
  const moved = transitionTaskArtifactActionDelivery({ actionId: action.id, from: 'accepted', to: 'delivered', note: `thread ${turn.threadId}`, deliveredAt: nowIso() });
  return moved ? { ok: true } : { ok: false, reason: 'action was delivered concurrently' };
}
