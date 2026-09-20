import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { getSqlite } from '@/lib/db';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { modelBelongsToRuntime } from '@/lib/lane/orchestrator-model-guard';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { listLanes } from '@/lib/lane/registry';
import {
  appendMobileOrchestratorUserMessage,
  markMobileOrchestratorThreadFailed,
  upsertMobileOrchestratorAssistantMessage,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { resolveEffortPin, type ConcreteThinkingEffort } from '@/lib/orchestrator/effort-pin';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { withSessionRules } from '@/lib/orchestrator/session-rules-prompt';
import { withOrchestratorTurnReceiptContext } from '@/lib/orchestrator/turn-receipt-context';
import { sendOrchestratorBackendTurn } from '@/lib/lane/orchestrator-send-entry';

export type LeadStatus = 'queued' | 'running' | 'waiting_workers' | 'completed'
  | 'blocked' | 'needs_approval' | 'failed' | 'stopped';

export interface LeadBrief {
  objective: string;
  scope: string[];
  doneTests: string[];
  nonGoals: string[];
  budgets: string[];
  escalationCriteria: string[];
}

export interface LeadRouting {
  backend: 'codex' | 'claude';
  model: string;
  effort: ConcreteThinkingEffort;
}

export interface StartLeadInput extends LeadRouting {
  repoPath: string;
  idempotencyKey: string;
  brief: LeadBrief;
}

export interface SendLeadInput {
  leadId: string;
  message: string;
  idempotencyKey: string;
  repoPath?: string;
  threadId?: string;
  backend?: OrchestratorBackendId;
  model?: string;
  effort?: string;
}

export class LeadLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LeadLifecycleError';
  }
}

interface LeadRow {
  id: string;
  start_key: string;
  request_digest: string;
  thread_id: string;
  repo_path: string;
  backend: 'codex' | 'claude';
  model: string;
  effort: ConcreteThinkingEffort;
  status: LeadStatus;
  current_turn_id: string | null;
  result_status: string | null;
  result_text: string | null;
  error: string | null;
  stop_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface TurnRow {
  id: string;
  lead_id: string;
  idempotency_key: string;
  ordinal: number;
  kind: 'operator' | 'review';
  message: string;
  brief_json: string | null;
  status: LeadStatus | 'interrupted';
  result_text: string | null;
  error: string | null;
  session_id: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  owner_pid: number | null;
}

const activeRuns = new Map<string, AbortController>();
const drains = new Set<string>();
const TERMINAL = new Set<LeadStatus>(['completed', 'blocked', 'needs_approval', 'failed', 'stopped']);

function clean(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LeadLifecycleError(`${field} is required.`, 'invalid_lead_request', 400);
  }
  const result = value.trim();
  if (result.length > max) {
    throw new LeadLifecycleError(`${field} must be ${max} characters or fewer.`, 'invalid_lead_request', 400);
  }
  return result;
}

function list(value: unknown, field: string, required = false): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new LeadLifecycleError(`${field} must be an array with at most 50 entries.`, 'invalid_lead_request', 400);
  }
  const items = value.map((item, index) => clean(item, `${field}[${index}]`, 2_000));
  if (required && items.length === 0) {
    throw new LeadLifecycleError(`${field} must contain at least one entry.`, 'invalid_lead_request', 400);
  }
  return items;
}

export function validateLeadBrief(value: unknown): LeadBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeadLifecycleError('brief must be an object.', 'invalid_lead_request', 400);
  }
  const brief = value as Record<string, unknown>;
  return {
    objective: clean(brief.objective, 'brief.objective'),
    scope: list(brief.scope, 'brief.scope', true),
    doneTests: list(brief.doneTests, 'brief.doneTests', true),
    nonGoals: list(brief.nonGoals, 'brief.nonGoals'),
    budgets: list(brief.budgets, 'brief.budgets'),
    escalationCriteria: list(brief.escalationCriteria, 'brief.escalationCriteria', true),
  };
}

function validateRouting(input: { backend: unknown; model: unknown; effort: unknown }): LeadRouting {
  if (input.backend !== 'codex' && input.backend !== 'claude') {
    throw new LeadLifecycleError('backend must be codex or claude.', 'unsupported_lead_backend', 400);
  }
  const model = clean(input.model, 'model', 256);
  const runtime = input.backend === 'codex' ? 'codex' : 'claude-code';
  if (!modelBelongsToRuntime(model, runtime)) {
    throw new LeadLifecycleError(
      `Model "${model}" is incompatible with backend "${input.backend}".`,
      'lead_model_incompatible',
      400,
    );
  }
  const effort = resolveEffortPin({
    requestedEffort: input.effort,
    runtime,
    model,
    explicitModel: model,
  });
  if (!effort.ok || !effort.selectedEffort || effort.selectedEffort === 'adaptive') {
    throw new LeadLifecycleError(
      effort.ok ? 'A concrete effort pin is required.' : effort.message,
      effort.ok ? 'lead_effort_required' : effort.code,
      400,
    );
  }
  return { backend: input.backend, model, effort: effort.selectedEffort };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function resolveRepoPath(value: string, field = 'repoPath'): string {
  try {
    assertOrchestratorRepoPath(value);
    return realpathSync(value);
  } catch (error) {
    throw new LeadLifecycleError(
      `${field} must name an existing Git repository: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_lead_repo',
      400,
    );
  }
}

function pidIsAlive(pid: number | null): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function event(leadId: string, turnId: string | null, kind: string, status: string, detail?: string): void {
  getSqlite().prepare(`
    INSERT INTO orchestrator_lead_events (lead_id, turn_id, kind, status, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leadId, turnId, kind, status, detail?.slice(0, 1_000) ?? null, Date.now());
}

function leadById(id: string): LeadRow | null {
  return getSqlite().prepare('SELECT * FROM orchestrator_leads WHERE id = ?').get(id) as LeadRow | undefined ?? null;
}

function turnByKey(leadId: string, key: string): TurnRow | null {
  return getSqlite().prepare(
    'SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? AND idempotency_key = ?',
  ).get(leadId, key) as TurnRow | undefined ?? null;
}

function assertLeadBinding(lead: LeadRow, input: SendLeadInput): void {
  const checks: Array<[unknown, unknown, string]> = [
    [input.repoPath ? resolveRepoPath(input.repoPath) : undefined, lead.repo_path, 'repoPath'],
    [input.threadId, lead.thread_id, 'threadId'],
    [input.backend, lead.backend, 'backend'],
    [input.model, lead.model, 'model'],
    [input.effort, lead.effort, 'effort'],
  ];
  for (const [requested, selected, field] of checks) {
    if (requested !== undefined && requested !== selected) {
      throw new LeadLifecycleError(
        `${field} does not match the persistent lead binding.`,
        'lead_binding_mismatch',
        409,
      );
    }
  }
}

function buildLeadPrompt(message: string, brief: LeadBrief | null, isReview: boolean): string {
  const contract = [
    '<Persistent o8 lead contract>',
    'You are the durable execution lead for this bounded task. Use o8 operator tools to dispatch workers when needed.',
    'You own worker review, corrections, verification, and the final handback. Do not report completion merely because a worker exited.',
    'Preserve approval gates. Never approve or merge on the operator\'s behalf. Escalate only under the supplied criteria.',
    isReview
      ? 'A worker reached review. Inspect its persisted packet/diff/evidence, then review, correct, or surface the appropriate terminal outcome.'
      : 'Continue this same lead conversation and retain the task routing and scope.',
    '</Persistent o8 lead contract>',
  ];
  if (brief) {
    contract.push(
      '',
      '<Task brief>',
      `Objective: ${brief.objective}`,
      `Scope:\n- ${brief.scope.join('\n- ')}`,
      `Done tests:\n- ${brief.doneTests.join('\n- ')}`,
      `Non-goals:\n- ${brief.nonGoals.join('\n- ') || '(none)'}`,
      `Budgets:\n- ${brief.budgets.join('\n- ') || '(none)'}`,
      `Escalation criteria:\n- ${brief.escalationCriteria.join('\n- ')}`,
      '</Task brief>',
    );
  }
  return `${contract.join('\n')}\n\n${message}`;
}

function threadPackets(threadId: string) {
  const states = [
    readOrchestratorControlPlaneState(),
    ...listMissionRegistryEntries({ includeArchived: false }).map((entry) => entry.mission),
  ];
  const packets = new Map<string, (typeof states)[number]['packets'][number]>();
  for (const state of states) {
    for (const packet of state.packets) {
      if (packet.orchestratorThreadId === threadId) packets.set(packet.id, packet);
    }
  }
  return [...packets.values()];
}

async function classifyLead(lead: LeadRow): Promise<{ status: LeadStatus; detail: string }> {
  const packets = threadPackets(lead.thread_id);
  if (packets.length === 0) return { status: 'completed', detail: 'Lead turn completed without worker obligations.' };
  const packetIds = new Set(packets.map((packet) => packet.id));
  const lanes = listLanes().filter((lane) => lane.packetId && packetIds.has(lane.packetId));
  if (lanes.some((lane) => lane.status === 'awaiting_human' || lane.status === 'awaiting_input')) {
    return { status: 'needs_approval', detail: 'A bound worker requires operator input or approval.' };
  }
  if (lanes.some((lane) => lane.status === 'failed')) {
    return { status: 'failed', detail: 'A bound worker failed.' };
  }
  if (lanes.some((lane) => lane.status === 'awaiting_orchestrator')) {
    return { status: 'blocked', detail: 'A bound worker is blocked on lead review.' };
  }
  if (packets.some((packet) => packet.review?.approved === true && packet.releaseState !== 'released')) {
    return { status: 'needs_approval', detail: 'Lead review passed; operator-controlled release remains pending.' };
  }
  const durableReviewStates = await Promise.all(lanes.map((lane) => hasDurableApprovedReview(lane)));
  if (durableReviewStates.some(Boolean)) {
    return { status: 'needs_approval', detail: 'Lead review passed; operator-controlled release remains pending.' };
  }
  const open = packets.some((packet) => packet.status !== 'archived'
    && packet.status !== 'failed'
    && packet.releaseState !== 'released');
  if (open) return { status: 'waiting_workers', detail: 'Lead is waiting for bound worker completion or review.' };
  return { status: 'completed', detail: 'All bound worker obligations are released.' };
}

function claimTurn(leadId: string): TurnRow | null {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const lead = leadById(leadId);
    if (!lead || lead.status === 'stopped') return null;
    const running = sqlite.prepare(
      `SELECT id FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'running' LIMIT 1`,
    ).get(leadId);
    if (running) return null;
    const turn = sqlite.prepare(
      `SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1`,
    ).get(leadId) as TurnRow | undefined;
    if (!turn) return null;
    const now = Date.now();
    sqlite.prepare(
      `UPDATE orchestrator_lead_turns SET status = 'running', started_at = ?, owner_pid = ? WHERE id = ? AND status = 'queued'`,
    ).run(now, process.pid, turn.id);
    sqlite.prepare(
      `UPDATE orchestrator_leads SET status = 'running', current_turn_id = ?, updated_at = ? WHERE id = ? AND status != 'stopped'`,
    ).run(turn.id, now, leadId);
    event(leadId, turn.id, 'turn', 'running');
    return { ...turn, status: 'running' as const, started_at: now, owner_pid: process.pid };
  })();
}

async function executeTurn(lead: LeadRow, turn: TurnRow): Promise<void> {
  appendMobileOrchestratorUserMessage({
    tabId: lead.thread_id,
    repoPath: lead.repo_path,
    message: turn.message,
    messageId: `lead-user-${turn.id}`,
    backend: lead.backend,
  });
  const controller = new AbortController();
  activeRuns.set(lead.id, controller);
  let text = '';
  let sessionId: string | null = null;
  let turnError: string | null = null;
  const stopPoll = setInterval(() => {
    if (leadById(lead.id)?.status === 'stopped') controller.abort();
  }, 200);
  try {
    const brief = turn.brief_json ? JSON.parse(turn.brief_json) as LeadBrief : null;
    let prompt = buildLeadPrompt(turn.message, brief, turn.kind === 'review');
    prompt = withSessionRules(prompt, lead.thread_id);
    prompt = withOrchestratorTurnReceiptContext({
      message: prompt,
      threadId: lead.thread_id,
      turnId: `lead-assistant-${turn.id}`,
    });
    await sendOrchestratorBackendTurn(
      getOrchestratorBackend(lead.backend),
      lead.repo_path,
      prompt,
      (item: OrchestratorEvent) => {
        if (item.type === 'text') text += item.text;
        if (item.type === 'done') sessionId = item.sessionId;
        if (item.type === 'error') turnError = item.error;
      },
      {
        model: lead.model,
        thinkingEffort: lead.effort,
        threadId: lead.thread_id,
        permissionMode: 'full',
        signal: controller.signal,
      },
      'fleet',
    );
    if (turnError) throw new Error(turnError);
    const current = leadById(lead.id);
    if (!current || current.status === 'stopped') return;
    if (sessionId) writeOrchestratorBackendSessionId(lead.thread_id, lead.backend, sessionId);
    const classification = await classifyLead(current);
    const now = Date.now();
    getSqlite().transaction(() => {
      getSqlite().prepare(
        `UPDATE orchestrator_lead_turns SET status = ?, result_text = ?, session_id = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).run(classification.status, text || null, sessionId, now, turn.id);
      getSqlite().prepare(
        `UPDATE orchestrator_leads SET status = ?, current_turn_id = NULL, result_status = ?, result_text = ?, error = NULL, updated_at = ? WHERE id = ? AND status != 'stopped'`,
      ).run(classification.status, classification.status, text || null, now, lead.id);
      event(lead.id, turn.id, 'turn', classification.status, classification.detail);
    })();
    upsertMobileOrchestratorAssistantMessage({
      tabId: lead.thread_id,
      repoPath: lead.repo_path,
      messageId: `lead-assistant-${turn.id}`,
      content: text || classification.detail,
      backend: lead.backend,
      model: lead.model,
      sessionId,
    });
  } catch (error) {
    const current = leadById(lead.id);
    if (!current || current.status === 'stopped') return;
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    getSqlite().transaction(() => {
      getSqlite().prepare(
        `UPDATE orchestrator_lead_turns SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).run(message, now, turn.id);
      getSqlite().prepare(
        `UPDATE orchestrator_leads SET status = 'failed', current_turn_id = NULL, result_status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status != 'stopped'`,
      ).run(message, now, lead.id);
      event(lead.id, turn.id, 'turn', 'failed', message);
    })();
    markMobileOrchestratorThreadFailed({
      tabId: lead.thread_id,
      repoPath: lead.repo_path,
      error: message,
      backend: lead.backend,
    });
  } finally {
    clearInterval(stopPoll);
    activeRuns.delete(lead.id);
  }
}

async function drainLead(leadId: string): Promise<void> {
  if (drains.has(leadId)) return;
  drains.add(leadId);
  try {
    while (true) {
      const turn = claimTurn(leadId);
      if (!turn) return;
      const lead = leadById(leadId);
      if (!lead) return;
      await executeTurn(lead, turn);
      if (leadById(leadId)?.status === 'stopped') return;
    }
  } finally {
    drains.delete(leadId);
  }
}

function kickLead(leadId: string): void {
  void drainLead(leadId).catch((error) => {
    console.error(`[lead-lifecycle] drain failed for ${leadId}:`, error);
  });
}

function insertTurn(input: {
  lead: LeadRow;
  key: string;
  kind: 'operator' | 'review';
  message: string;
  brief?: LeadBrief;
}): TurnRow {
  const existing = turnByKey(input.lead.id, input.key);
  if (existing) {
    if (existing.message !== input.message) {
      throw new LeadLifecycleError(
        'The idempotency key is already bound to a different message.',
        'lead_idempotency_conflict',
        409,
      );
    }
    return existing;
  }
  if (input.lead.status === 'stopped') {
    throw new LeadLifecycleError('A stopped lead cannot accept new turns.', 'lead_stopped', 409);
  }
  const sqlite = getSqlite();
  let turn: TurnRow | null = null;
  for (let attempt = 0; attempt < 2 && !turn; attempt += 1) {
    try {
      turn = sqlite.transaction(() => {
        const ordinal = (sqlite.prepare(
          'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM orchestrator_lead_turns WHERE lead_id = ?',
        ).get(input.lead.id) as { ordinal: number }).ordinal;
        const row: TurnRow = {
          id: `lead-turn-${randomUUID()}`,
          lead_id: input.lead.id,
          idempotency_key: input.key,
          ordinal,
          kind: input.kind,
          message: input.message,
          brief_json: input.brief ? JSON.stringify(input.brief) : null,
          status: 'queued',
          result_text: null,
          error: null,
          session_id: null,
          created_at: Date.now(),
          started_at: null,
          finished_at: null,
          owner_pid: null,
        };
        sqlite.prepare(`
          INSERT INTO orchestrator_lead_turns
            (id, lead_id, idempotency_key, ordinal, kind, message, brief_json, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        `).run(row.id, row.lead_id, row.idempotency_key, row.ordinal, row.kind, row.message, row.brief_json, row.created_at);
        sqlite.prepare(
          `UPDATE orchestrator_leads SET status = 'queued', result_status = NULL, error = NULL, updated_at = ? WHERE id = ? AND status != 'stopped'`,
        ).run(row.created_at, input.lead.id);
        event(input.lead.id, row.id, 'turn', 'queued');
        return row;
      })();
    } catch (error) {
      const admitted = turnByKey(input.lead.id, input.key);
      if (admitted) {
        if (admitted.message !== input.message) {
          throw new LeadLifecycleError(
            'The idempotency key is already bound to a different message.',
            'lead_idempotency_conflict',
            409,
          );
        }
        return admitted;
      }
      if (attempt === 1) throw error;
    }
  }
  if (!turn) throw new Error('Lead turn admission did not produce a row.');
  kickLead(input.lead.id);
  return turn;
}

export function startLead(input: StartLeadInput) {
  const routing = validateRouting(input);
  const brief = validateLeadBrief(input.brief);
  const idempotencyKey = clean(input.idempotencyKey, 'idempotencyKey', 256);
  const repoPath = resolveRepoPath(input.repoPath);
  const requestDigest = digest({ repoPath, ...routing, brief });
  const sqlite = getSqlite();
  const existing = sqlite.prepare('SELECT * FROM orchestrator_leads WHERE start_key = ?').get(idempotencyKey) as LeadRow | undefined;
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      throw new LeadLifecycleError(
        'The start idempotency key is already bound to a different request.',
        'lead_idempotency_conflict',
        409,
      );
    }
    return getLeadStatus(existing.id);
  }
  const now = Date.now();
  const leadId = `lead-${randomUUID()}`;
  const lead: LeadRow = {
    id: leadId,
    start_key: idempotencyKey,
    request_digest: requestDigest,
    thread_id: `thoughts-${leadId}`,
    repo_path: repoPath,
    ...routing,
    status: 'queued',
    current_turn_id: null,
    result_status: null,
    result_text: null,
    error: null,
    stop_reason: null,
    created_at: now,
    updated_at: now,
  };
  try {
    sqlite.transaction(() => {
      sqlite.prepare(`
        INSERT INTO orchestrator_leads
          (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(lead.id, lead.start_key, lead.request_digest, lead.thread_id, lead.repo_path,
        lead.backend, lead.model, lead.effort, now, now);
      event(lead.id, null, 'lead', 'queued', 'Persistent lead admitted.');
    })();
  } catch (error) {
    const admitted = sqlite.prepare('SELECT * FROM orchestrator_leads WHERE start_key = ?').get(idempotencyKey) as LeadRow | undefined;
    if (!admitted) throw error;
    if (admitted.request_digest !== requestDigest) {
      throw new LeadLifecycleError(
        'The start idempotency key is already bound to a different request.',
        'lead_idempotency_conflict',
        409,
      );
    }
    return getLeadStatus(admitted.id);
  }
  insertTurn({
    lead,
    key: `start:${idempotencyKey}`,
    kind: 'operator',
    message: brief.objective,
    brief,
  });
  return getLeadStatus(lead.id);
}

export function sendLead(input: SendLeadInput) {
  const leadId = clean(input.leadId, 'leadId', 128);
  const message = clean(input.message, 'message', 20_000);
  const key = clean(input.idempotencyKey, 'idempotencyKey', 256);
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  assertLeadBinding(lead, input);
  const turn = insertTurn({ lead, key, kind: 'operator', message });
  return { ...getLeadStatus(lead.id), admittedTurnId: turn.id };
}

export function stopLead(leadIdRaw: string, reasonRaw?: string) {
  const leadId = clean(leadIdRaw, 'leadId', 128);
  const reason = reasonRaw ? clean(reasonRaw, 'reason', 1_000) : 'Stopped by operator.';
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  const now = Date.now();
  getSqlite().transaction(() => {
    getSqlite().prepare(`
      UPDATE orchestrator_leads
      SET status = 'stopped', result_status = 'stopped', stop_reason = ?, current_turn_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(reason, now, leadId);
    getSqlite().prepare(`
      UPDATE orchestrator_lead_turns
      SET status = 'stopped', error = ?, finished_at = ?
      WHERE lead_id = ? AND status IN ('queued', 'running')
    `).run(reason, now, leadId);
    event(leadId, lead.current_turn_id, 'lead', 'stopped', reason);
  })();
  activeRuns.get(leadId)?.abort();
  return getLeadStatus(leadId);
}

export function recoverInterruptedLeadTurns(): number {
  const sqlite = getSqlite();
  const stale = sqlite.prepare(`
    SELECT * FROM orchestrator_lead_turns
    WHERE status = 'running' AND (owner_pid IS NULL OR owner_pid != ?)
  `).all(process.pid) as TurnRow[];
  const interrupted = stale.filter((turn) => !pidIsAlive(turn.owner_pid));
  for (const turn of interrupted) {
    const now = Date.now();
    sqlite.transaction(() => {
      sqlite.prepare(`
        UPDATE orchestrator_lead_turns
        SET status = 'interrupted', error = 'Lead process exited during this turn.', finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, turn.id);
      sqlite.prepare(`
        UPDATE orchestrator_leads
        SET status = 'blocked', result_status = 'blocked', current_turn_id = NULL,
            error = 'Previous lead turn was interrupted; send a new turn to recover.', updated_at = ?
        WHERE id = ? AND status != 'stopped'
      `).run(now, turn.lead_id);
      event(turn.lead_id, turn.id, 'recovery', 'blocked', 'Interrupted turn preserved; explicit send required.');
    })();
  }
  return interrupted.length;
}

export function getLeadStatus(leadIdRaw: string, afterCursor = 0) {
  const leadId = clean(leadIdRaw, 'leadId', 128);
  recoverInterruptedLeadTurns();
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  if (lead.status === 'queued') kickLead(lead.id);
  const sqlite = getSqlite();
  const latestTurn = sqlite.prepare(
    'SELECT * FROM orchestrator_lead_turns WHERE lead_id = ? ORDER BY ordinal DESC LIMIT 1',
  ).get(leadId) as TurnRow | undefined;
  const queueDepth = (sqlite.prepare(
    `SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'queued'`,
  ).get(leadId) as { count: number }).count;
  const events = sqlite.prepare(`
    SELECT cursor, turn_id AS turnId, kind, status, detail, created_at AS createdAt
    FROM orchestrator_lead_events WHERE lead_id = ? AND cursor > ? ORDER BY cursor LIMIT 100
  `).all(leadId, Math.max(0, afterCursor)) as Array<Record<string, unknown>>;
  const cursor = events.length > 0 ? Number(events[events.length - 1].cursor) : Math.max(0, afterCursor);
  return {
    schema: 'o8/orchestrator.lead/v1',
    ok: true,
    lead: {
      id: lead.id,
      threadId: lead.thread_id,
      repoPath: lead.repo_path,
      routing: { backend: lead.backend, model: lead.model, effort: lead.effort },
      status: lead.status,
      currentTurnId: lead.current_turn_id,
      result: lead.result_status ? {
        status: lead.result_status,
        text: lead.result_text?.slice(0, 2_000) ?? null,
        textTruncated: Boolean(lead.result_text && lead.result_text.length > 2_000),
        error: lead.error?.slice(0, 2_000) ?? null,
        errorTruncated: Boolean(lead.error && lead.error.length > 2_000),
      } : null,
      stopReason: lead.stop_reason,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    },
    latestTurn: latestTurn ? {
      id: latestTurn.id,
      ordinal: latestTurn.ordinal,
      kind: latestTurn.kind,
      status: latestTurn.status,
      error: latestTurn.error?.slice(0, 2_000) ?? null,
      errorTruncated: Boolean(latestTurn.error && latestTurn.error.length > 2_000),
      createdAt: latestTurn.created_at,
      finishedAt: latestTurn.finished_at,
    } : null,
    queueDepth,
    cursor,
    events,
  };
}

export async function waitForLead(input: { leadId: string; afterCursor?: number; waitMs?: number }) {
  const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 30_000);
  const deadline = Date.now() + waitMs;
  let status = getLeadStatus(input.leadId, input.afterCursor ?? 0);
  while (Date.now() < deadline && status.events.length === 0 && !TERMINAL.has(status.lead.status)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    status = getLeadStatus(input.leadId, input.afterCursor ?? 0);
  }
  return status;
}

export function queueLeadReviewContinuation(input: {
  repoPath: string;
  packetId: string;
  laneId: string;
  label: string;
}): boolean {
  const packet = threadPacketsForPacket(input.packetId);
  if (!packet?.orchestratorThreadId) return false;
  const lead = getSqlite().prepare(
    'SELECT * FROM orchestrator_leads WHERE thread_id = ?',
  ).get(packet.orchestratorThreadId) as LeadRow | undefined;
  if (!lead) return false;
  if (lead.status === 'stopped') return true;
  let repoPath: string | null = null;
  try { repoPath = realpathSync(input.repoPath); } catch { /* handled below */ }
  if (lead.repo_path !== repoPath) {
    const message = 'Worker review return did not match the lead repository binding.';
    getSqlite().prepare(`
      UPDATE orchestrator_leads
      SET status = 'blocked', result_status = 'blocked', error = ?, updated_at = ?
      WHERE id = ? AND status != 'stopped'
    `).run(message, Date.now(), lead.id);
    event(lead.id, null, 'review', 'blocked', message);
    return true;
  }
  const message = [
    `[FLEET] Lane "${input.label}" (${input.laneId}, packet ${input.packetId}) reached review-ready.`,
    'Inspect the packet diff, verification, and governance state. Review it, request corrections if needed, and only then produce the terminal handback.',
  ].join('\n');
  try {
    insertTurn({
      lead,
      key: `review:${input.laneId}:${packet.status}:${packet.lastEventAt ?? packet.review?.recordedAt ?? 'ready'}`,
      kind: 'review',
      message,
    });
  } catch (error) {
    const detail = `Worker review return could not be admitted: ${error instanceof Error ? error.message : String(error)}`;
    getSqlite().prepare(`
      UPDATE orchestrator_leads
      SET status = 'blocked', result_status = 'blocked', error = ?, updated_at = ?
      WHERE id = ? AND status != 'stopped'
    `).run(detail, Date.now(), lead.id);
    event(lead.id, null, 'review', 'blocked', detail);
  }
  return true;
}

function threadPacketsForPacket(packetId: string) {
  const states = [
    readOrchestratorControlPlaneState(),
    ...listMissionRegistryEntries({ includeArchived: false }).map((entry) => entry.mission),
  ];
  for (const state of states) {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (packet) return packet;
  }
  return null;
}

export function __resetLeadRuntimeForTests(): void {
  for (const controller of activeRuns.values()) controller.abort();
  activeRuns.clear();
  drains.clear();
}
