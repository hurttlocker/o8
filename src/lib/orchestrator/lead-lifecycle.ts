import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { getSqlite } from '@/lib/db';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { findLaneBySession, listLanes } from '@/lib/lane/registry';
import {
  appendMobileOrchestratorUserMessage,
  markMobileOrchestratorThreadFailed,
  upsertMobileOrchestratorAssistantMessage,
  writeOrchestratorBackendSessionId,
} from '@/lib/mobile/orchestrator-thread-history';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import {
  cleanLeadString,
  digestLeadRequest,
  LeadLifecycleError,
  resolveLeadRepoPath,
  type LeadBrief,
  type LeadRow,
  type LeadStatus,
  type ReportLeadOutcomeInput,
  type SendLeadInput,
  type StartLeadInput,
  type TurnRow,
  validateLeadBrief,
  validateLeadRouting,
  validateLeadStringList,
} from '@/lib/orchestrator/lead-contract';
import { listMissionRegistryEntries } from '@/lib/orchestrator/mission-registry';
import { withSessionRules } from '@/lib/orchestrator/session-rules-prompt';
import { withOrchestratorTurnReceiptContext } from '@/lib/orchestrator/turn-receipt-context';
import { escalationSessionKey } from '@/lib/orchestrator/wake-triage';
import { sendOrchestratorBackendTurn } from '@/lib/lane/orchestrator-send-entry';
import {
  appendLeadEvent as event,
  findLeadById as leadById,
  findLeadTurnByKey as turnByKey,
  getLeadStatus,
} from '@/lib/orchestrator/lead-status';
import { currentLeadOwnerIdentityJson } from '@/lib/orchestrator/lead-turn-owner';

export { LeadLifecycleError, validateLeadBrief } from '@/lib/orchestrator/lead-contract';
export { getLeadStatus, recoverInterruptedLeadTurns, waitForLead } from '@/lib/orchestrator/lead-status';

const activeRuns = new Map<string, AbortController>();
const drains = new Set<string>();
function assertLeadBinding(lead: LeadRow, input: SendLeadInput): void {
  const checks: Array<[unknown, unknown, string]> = [
    [input.repoPath ? resolveLeadRepoPath(input.repoPath) : undefined, lead.repo_path, 'repoPath'],
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

function buildLeadPrompt(lead: LeadRow, turn: TurnRow, brief: LeadBrief | null): string {
  const contract = [
    '<Persistent o8 lead contract>',
    'You are the durable execution lead for this bounded task. Use o8 operator tools to dispatch workers when needed.',
    'You own worker review, corrections, verification, and the final handback. Do not report completion merely because a worker exited.',
    'Preserve approval gates. Never approve or merge on the operator\'s behalf. Escalate only under the supplied criteria.',
    turn.kind !== 'operator'
      ? 'A worker reached review. Inspect its persisted packet/diff/evidence, then review, correct, or surface the appropriate terminal outcome.'
      : 'Continue this same lead conversation and retain the task routing and scope.',
    'Before ending this turn, report exactly one structured outcome through the operator-authenticated CLI:',
    `o8 lead report ${lead.id} --turn ${turn.id} --repo ${JSON.stringify(lead.repo_path)} --thread-id ${lead.thread_id} --kind <completed|waiting_workers|needs_context|needs_approval|blocked> --summary <text> --evidence <json-array>`,
    'Use completed only when the objective is actually complete, evidence is supplied, and no worker/review/approval obligation remains. This receipt, not freeform prose or process exit, determines terminal state.',
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
  return `${contract.join('\n')}\n\n${turn.message}`;
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

async function classifyLead(lead: LeadRow, turn: TurnRow): Promise<{ status: LeadStatus; detail: string }> {
  const packets = threadPackets(lead.thread_id);
  const packetIds = new Set(packets.map((packet) => packet.id));
  const lanes = listLanes().filter((lane) => lane.packetId && packetIds.has(lane.packetId));
  if (lanes.some((lane) => lane.status === 'awaiting_human')) {
    return { status: 'needs_approval', detail: 'A bound worker requires a distinct human approval.' };
  }
  if (packets.some((packet) => packet.review?.approved === true && packet.releaseState !== 'released')) {
    return { status: 'needs_approval', detail: 'Lead review passed; operator-controlled release remains pending.' };
  }
  const durableReviewStates = await Promise.all(lanes.map((lane) => hasDurableApprovedReview(lane)));
  if (durableReviewStates.some(Boolean)) {
    return { status: 'needs_approval', detail: 'Lead review passed; operator-controlled release remains pending.' };
  }
  const activeWorker = lanes.some((lane) => ['claimed', 'running', 'retrying'].includes(lane.status));
  const openPacket = packets.some((packet) => packet.status !== 'archived'
    && packet.status !== 'failed'
    && packet.releaseState !== 'released');
  if (activeWorker || (openPacket && lanes.length === 0)) {
    return { status: 'waiting_workers', detail: 'Lead is waiting for a bound worker return.' };
  }
  const unresolvedReview = lanes.some((lane) => ['reviewing', 'awaiting_orchestrator', 'awaiting_input', 'failed'].includes(lane.status));
  if (unresolvedReview) {
    return { status: 'blocked', detail: 'A bound worker failure, context request, or review obligation remains unresolved.' };
  }
  if (!turn.outcome_kind) {
    return { status: 'blocked', detail: 'The lead process exited without a structured terminal outcome.' };
  }
  if (turn.outcome_kind === 'completed') {
    const evidence = turn.outcome_evidence_json
      ? JSON.parse(turn.outcome_evidence_json) as unknown
      : null;
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { status: 'blocked', detail: 'The lead claimed completion without structured evidence.' };
    }
    return { status: 'completed', detail: turn.outcome_summary ?? 'Lead reported completion with evidence.' };
  }
  if (turn.outcome_kind === 'needs_approval') {
    return { status: 'needs_approval', detail: turn.outcome_summary ?? 'Lead requested human approval.' };
  }
  if (turn.outcome_kind === 'waiting_workers') {
    return { status: 'blocked', detail: 'The lead reported waiting_workers but no authoritative worker remained active.' };
  }
  return { status: 'blocked', detail: turn.outcome_summary ?? 'Lead reported a blocked or context-required outcome.' };
}

function claimTurn(leadId: string): TurnRow | null {
  const sqlite = getSqlite();
  const leaseToken = randomUUID();
  const ownerIdentityJson = currentLeadOwnerIdentityJson();
  return sqlite.transaction(() => {
    const now = Date.now();
    const turn = sqlite.prepare(`
      UPDATE orchestrator_lead_turns
      SET status = 'running', started_at = ?, owner_pid = ?, owner_identity_json = ?,
          lease_token = ?, lease_heartbeat_at = ?
      WHERE id = (
        SELECT id FROM orchestrator_lead_turns
        WHERE lead_id = ? AND status = 'queued'
        ORDER BY ordinal LIMIT 1
      )
        AND NOT EXISTS (
          SELECT 1 FROM orchestrator_lead_turns
          WHERE lead_id = ? AND status = 'running'
        )
        AND EXISTS (
          SELECT 1 FROM orchestrator_leads
          WHERE id = ? AND status != 'stopped'
        )
      RETURNING *
    `).get(now, process.pid, ownerIdentityJson, leaseToken, now, leadId, leadId, leadId) as TurnRow | undefined;
    if (!turn) return null;
    sqlite.prepare(
      `UPDATE orchestrator_leads SET status = 'running', current_turn_id = ?, updated_at = ? WHERE id = ? AND status != 'stopped'`,
    ).run(turn.id, now, leadId);
    event(leadId, turn.id, 'turn', 'running');
    return turn;
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
  const heartbeat = setInterval(() => {
    getSqlite().prepare(`
      UPDATE orchestrator_lead_turns SET lease_heartbeat_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?
    `).run(Date.now(), turn.id, turn.lease_token);
  }, 1_000);
  heartbeat.unref();
  const stopPoll = setInterval(() => {
    if (leadById(lead.id)?.status === 'stopped') controller.abort();
  }, 200);
  stopPoll.unref();
  try {
    const brief = turn.brief_json ? JSON.parse(turn.brief_json) as LeadBrief : null;
    let prompt = buildLeadPrompt(lead, turn, brief);
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
    const reportedTurn = getSqlite().prepare(
      'SELECT * FROM orchestrator_lead_turns WHERE id = ?',
    ).get(turn.id) as TurnRow | undefined;
    if (!reportedTurn || reportedTurn.status !== 'running' || reportedTurn.lease_token !== turn.lease_token) return;
    const classification = await classifyLead(current, reportedTurn);
    const now = Date.now();
    getSqlite().transaction(() => {
      const settled = getSqlite().prepare(`
        UPDATE orchestrator_lead_turns SET status = ?, result_text = ?, session_id = ?, finished_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ?
      `).run(classification.status, text || null, sessionId, now, turn.id, turn.lease_token);
      if (settled.changes !== 1) return;
      const queued = (getSqlite().prepare(`
        SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'queued'
      `).get(lead.id) as { count: number }).count;
      getSqlite().prepare(`
        UPDATE orchestrator_leads
        SET status = ?, current_turn_id = NULL,
            result_turn_id = CASE WHEN ? > 0 THEN NULL ELSE ? END,
            result_status = CASE WHEN ? > 0 THEN NULL ELSE ? END,
            result_text = CASE WHEN ? > 0 THEN NULL ELSE ? END,
            error = NULL, updated_at = ?
        WHERE id = ? AND status != 'stopped' AND current_turn_id = ?
      `).run(queued > 0 ? 'queued' : classification.status,
        queued, turn.id, queued, classification.status, queued, text || null,
        now, lead.id, turn.id);
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
      const settled = getSqlite().prepare(`
        UPDATE orchestrator_lead_turns SET status = 'failed', error = ?, finished_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ?
      `).run(message, now, turn.id, turn.lease_token);
      if (settled.changes !== 1) return;
      const queued = (getSqlite().prepare(`
        SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ? AND status = 'queued'
      `).get(lead.id) as { count: number }).count;
      getSqlite().prepare(`
        UPDATE orchestrator_leads
        SET status = ?, current_turn_id = NULL,
            result_turn_id = CASE WHEN ? > 0 THEN NULL ELSE ? END,
            result_status = CASE WHEN ? > 0 THEN NULL ELSE 'failed' END,
            result_text = NULL,
            error = CASE WHEN ? > 0 THEN NULL ELSE ? END,
            updated_at = ?
        WHERE id = ? AND status != 'stopped' AND current_turn_id = ?
      `).run(queued > 0 ? 'queued' : 'failed', queued, turn.id, queued,
        queued, message, now, lead.id, turn.id);
      event(lead.id, turn.id, 'turn', 'failed', message);
    })();
    markMobileOrchestratorThreadFailed({
      tabId: lead.thread_id,
      repoPath: lead.repo_path,
      error: message,
      backend: lead.backend,
    });
  } finally {
    clearInterval(heartbeat);
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

function admitTurn(input: {
  lead: LeadRow;
  key: string;
  kind: 'operator' | 'review';
  message: string;
  brief?: LeadBrief;
}): TurnRow {
  const sqlite = getSqlite();
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
  const ordinal = (sqlite.prepare(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM orchestrator_lead_turns WHERE lead_id = ?',
  ).get(input.lead.id) as { ordinal: number }).ordinal;
  const turnId = `lead-turn-${randomUUID()}`;
  const now = Date.now();
  const inserted = sqlite.prepare(`
    INSERT INTO orchestrator_lead_turns
      (id, lead_id, idempotency_key, ordinal, kind, message, brief_json, status, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', ?
    FROM orchestrator_leads WHERE id = ? AND status != 'stopped'
  `).run(turnId, input.lead.id, input.key, ordinal, input.kind, input.message,
    input.brief ? JSON.stringify(input.brief) : null, now, input.lead.id);
  if (inserted.changes !== 1) {
    throw new LeadLifecycleError('A stopped lead cannot accept new turns.', 'lead_stopped', 409);
  }
  sqlite.prepare(`
    UPDATE orchestrator_leads
    SET status = 'queued', result_turn_id = NULL, result_status = NULL,
        result_text = NULL, error = NULL, updated_at = ?
    WHERE id = ? AND status != 'stopped'
  `).run(now, input.lead.id);
  event(input.lead.id, turnId, 'turn', 'queued');
  return sqlite.prepare('SELECT * FROM orchestrator_lead_turns WHERE id = ?').get(turnId) as TurnRow;
}

function insertTurn(input: Parameters<typeof admitTurn>[0]): TurnRow {
  const sqlite = getSqlite();
  let turn: TurnRow;
  try {
    turn = sqlite.transaction(() => admitTurn(input))();
  } catch (error) {
    const admitted = turnByKey(input.lead.id, input.key);
    if (!admitted) throw error;
    if (admitted.message !== input.message) {
      throw new LeadLifecycleError(
        'The idempotency key is already bound to a different message.',
        'lead_idempotency_conflict',
        409,
      );
    }
    turn = admitted;
  }
  kickLead(input.lead.id);
  return turn;
}

export function startLead(input: StartLeadInput) {
  const routing = validateLeadRouting(input);
  const brief = validateLeadBrief(input.brief);
  const idempotencyKey = cleanLeadString(input.idempotencyKey, 'idempotencyKey', 256);
  const repoPath = resolveLeadRepoPath(input.repoPath);
  const requestDigest = digestLeadRequest({ repoPath, ...routing, brief });
  const sqlite = getSqlite();
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
    result_turn_id: null,
    result_status: null,
    result_text: null,
    error: null,
    stop_reason: null,
    created_at: now,
    updated_at: now,
  };
  let admittedLead: LeadRow;
  let admittedTurn: TurnRow;
  try {
    ({ lead: admittedLead, turn: admittedTurn } = sqlite.transaction(() => {
      const existing = sqlite.prepare(
        'SELECT * FROM orchestrator_leads WHERE start_key = ?',
      ).get(idempotencyKey) as LeadRow | undefined;
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          throw new LeadLifecycleError(
            'The start idempotency key is already bound to a different request.',
            'lead_idempotency_conflict',
            409,
          );
        }
        const existingTurn = turnByKey(existing.id, `start:${idempotencyKey}`)
          ?? admitTurn({
            lead: existing,
            key: `start:${idempotencyKey}`,
            kind: 'operator',
            message: brief.objective,
            brief,
          });
        return { lead: existing, turn: existingTurn };
      }
      sqlite.prepare(`
        INSERT INTO orchestrator_leads
          (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(lead.id, lead.start_key, lead.request_digest, lead.thread_id, lead.repo_path,
        lead.backend, lead.model, lead.effort, now, now);
      event(lead.id, null, 'lead', 'queued', 'Persistent lead admitted.');
      return {
        lead,
        turn: admitTurn({
          lead,
          key: `start:${idempotencyKey}`,
          kind: 'operator',
          message: brief.objective,
          brief,
        }),
      };
    })());
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
    const turn = turnByKey(admitted.id, `start:${idempotencyKey}`);
    if (!turn) throw error;
    admittedLead = admitted;
    admittedTurn = turn;
  }
  kickLead(admittedLead.id);
  return { ...getLeadStatus(admittedLead.id, 0, admittedTurn.id), admittedTurnId: admittedTurn.id };
}

export function sendLead(input: SendLeadInput) {
  const leadId = cleanLeadString(input.leadId, 'leadId', 128);
  const message = cleanLeadString(input.message, 'message', 20_000);
  const key = cleanLeadString(input.idempotencyKey, 'idempotencyKey', 256);
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  assertLeadBinding(lead, input);
  const duplicate = Boolean(turnByKey(lead.id, key));
  const turn = insertTurn({ lead, key, kind: 'operator', message });
  return { ...getLeadStatus(lead.id), admittedTurnId: turn.id, duplicate };
}

export function sendLeadThreadMessage(input: {
  threadId: string;
  repoPath: string;
  message: string;
  idempotencyKey: string;
  backend?: string;
  model?: string;
  effort?: string;
}) {
  const threadId = cleanLeadString(input.threadId, 'threadId', 256);
  const lead = getSqlite().prepare(
    'SELECT * FROM orchestrator_leads WHERE thread_id = ?',
  ).get(threadId) as LeadRow | undefined;
  if (!lead) return null;
  return sendLead({
    leadId: lead.id,
    repoPath: input.repoPath,
    threadId,
    message: input.message,
    idempotencyKey: input.idempotencyKey,
    backend: input.backend as SendLeadInput['backend'],
    model: input.model,
    effort: input.effort,
  });
}

export function reportLeadOutcome(input: ReportLeadOutcomeInput) {
  const leadId = cleanLeadString(input.leadId, 'leadId', 128);
  const turnId = cleanLeadString(input.turnId, 'turnId', 128);
  const threadId = cleanLeadString(input.threadId, 'threadId', 256);
  const kind = input.kind;
  if (!['completed', 'waiting_workers', 'needs_context', 'needs_approval', 'blocked'].includes(kind)) {
    throw new LeadLifecycleError('kind is not a supported lead outcome.', 'invalid_lead_outcome', 400);
  }
  const summary = cleanLeadString(input.summary, 'summary', 2_000);
  const evidence = validateLeadStringList(input.evidence, 'evidence', kind === 'completed');
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  if (resolveLeadRepoPath(input.repoPath) !== lead.repo_path || threadId !== lead.thread_id) {
    throw new LeadLifecycleError(
      'The outcome does not match the lead repository/thread binding.',
      'lead_binding_mismatch',
      409,
    );
  }
  const sqlite = getSqlite();
  const turn = sqlite.prepare(
    'SELECT * FROM orchestrator_lead_turns WHERE id = ? AND lead_id = ?',
  ).get(turnId, leadId) as TurnRow | undefined;
  if (!turn) throw new LeadLifecycleError('Lead turn not found.', 'lead_turn_not_found', 404);
  const evidenceJson = JSON.stringify(evidence);
  if (turn.outcome_kind) {
    if (turn.outcome_kind === kind && turn.outcome_summary === summary
      && turn.outcome_evidence_json === evidenceJson) {
      return getLeadStatus(leadId, 0, turnId);
    }
    throw new LeadLifecycleError(
      'This turn already has a different structured outcome.',
      'lead_outcome_conflict',
      409,
    );
  }
  if (turn.status !== 'running' || !turn.lease_token || lead.status === 'stopped') {
    throw new LeadLifecycleError(
      'Only the active lead turn can report an outcome.',
      'lead_turn_not_active',
      409,
    );
  }
  const now = Date.now();
  const updated = sqlite.prepare(`
    UPDATE orchestrator_lead_turns
    SET outcome_kind = ?, outcome_summary = ?, outcome_evidence_json = ?, outcome_reported_at = ?
    WHERE id = ? AND lead_id = ? AND status = 'running' AND lease_token = ? AND outcome_kind IS NULL
  `).run(kind, summary, evidenceJson, now, turnId, leadId, turn.lease_token);
  if (updated.changes !== 1) {
    throw new LeadLifecycleError('The active turn changed before its outcome was recorded.', 'lead_outcome_race', 409);
  }
  event(leadId, turnId, 'outcome', kind, summary);
  return getLeadStatus(leadId, 0, turnId);
}

export function stopLead(leadIdRaw: string, reasonRaw?: string) {
  const leadId = cleanLeadString(leadIdRaw, 'leadId', 128);
  const reason = reasonRaw ? cleanLeadString(reasonRaw, 'reason', 1_000) : 'Stopped by operator.';
  const lead = leadById(leadId);
  if (!lead) throw new LeadLifecycleError('Lead not found.', 'lead_not_found', 404);
  const now = Date.now();
  getSqlite().transaction(() => {
    getSqlite().prepare(`
      UPDATE orchestrator_leads
      SET status = 'stopped', result_turn_id = current_turn_id, result_status = 'stopped',
          stop_reason = ?, current_turn_id = NULL, updated_at = ?
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

export function queueLeadReviewContinuation(input: {
  repoPath: string;
  packetId: string;
  laneId: string;
  label: string;
}): boolean {
  return queueLeadWorkerReturn({
    ...input,
    returnKind: 'review',
    detail: 'Inspect the packet diff, verification, and governance state. Review it, request corrections if needed, and only then produce the terminal handback.',
  });
}

export function queueLeadWorkerReturn(input: {
  repoPath: string;
  packetId: string;
  laneId: string;
  label: string;
  returnKind: 'review' | 'failed' | 'needs_context' | 'supervisor';
  detail: string;
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
    `[FLEET] Lane "${input.label}" (${input.laneId}, packet ${input.packetId}) returned ${input.returnKind}.`,
    input.detail,
  ].join('\n');
  try {
    insertTurn({
      lead,
      key: `worker-return:${input.laneId}`,
      kind: input.returnKind === 'review' ? 'review' : 'operator',
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

export function queueLeadSupervisorReturn(repoPath: string, message: string): boolean {
  const sessionKey = escalationSessionKey(message);
  if (!sessionKey) return false;
  const lane = findLaneBySession(sessionKey);
  if (!lane?.packetId) return false;
  return queueLeadWorkerReturn({
    repoPath,
    packetId: lane.packetId,
    laneId: lane.id,
    label: lane.label,
    returnKind: lane.status === 'awaiting_input' ? 'needs_context' : 'supervisor',
    detail: message,
  });
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
