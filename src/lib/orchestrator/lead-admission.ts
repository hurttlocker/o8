import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import {
  LeadLifecycleError,
  type LeadAttachment,
  type LeadBrief,
  type LeadRow,
  type TurnRow,
} from '@/lib/orchestrator/lead-contract';
import {
  appendLeadEvent as event,
  findLeadTurnByKey as turnByKey,
} from '@/lib/orchestrator/lead-status';

export interface LeadTurnAdmissionInput {
  lead: LeadRow;
  key: string;
  kind: 'operator' | 'review';
  message: string;
  displayMessage?: string;
  permissionMode?: 'full' | 'plan';
  attachments?: LeadAttachment[];
  brief?: LeadBrief;
  rootTurnId?: string;
}

export function admitLeadTurn(input: LeadTurnAdmissionInput): TurnRow {
  const sqlite = getSqlite();
  const existing = turnByKey(input.lead.id, input.key);
  if (existing) {
    const displayMessage = input.displayMessage ?? input.message;
    const attachmentsJson = input.attachments?.length ? JSON.stringify(input.attachments) : null;
    if (existing.message !== input.message || (existing.display_message || existing.message) !== displayMessage
      || existing.permission_mode !== (input.permissionMode ?? 'full')
      || existing.attachments_json !== attachmentsJson
      || existing.root_turn_id !== (input.rootTurnId ?? null)
      || existing.brief_json !== (input.brief ? JSON.stringify(input.brief) : null)) {
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
      (id, lead_id, root_turn_id, idempotency_key, ordinal, kind, message, display_message,
       permission_mode, attachments_json, brief_json, status, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?
    FROM orchestrator_leads WHERE id = ? AND status != 'stopped'
  `).run(turnId, input.lead.id, input.rootTurnId ?? null, input.key, ordinal, input.kind, input.message,
    input.displayMessage ?? input.message, input.permissionMode ?? 'full',
    input.attachments?.length ? JSON.stringify(input.attachments) : null,
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

export function insertLeadTurn(
  input: LeadTurnAdmissionInput,
  options: { onAdmitted?: (turn: TurnRow) => void } = {},
): TurnRow {
  const sqlite = getSqlite();
  try {
    return sqlite.transaction(() => {
      const existing = turnByKey(input.lead.id, input.key);
      const admitted = admitLeadTurn(input);
      if (!existing) options.onAdmitted?.(admitted);
      return admitted;
    })();
  } catch (error) {
    const admitted = turnByKey(input.lead.id, input.key);
    if (!admitted) throw error;
    const displayMessage = input.displayMessage ?? input.message;
    const attachmentsJson = input.attachments?.length ? JSON.stringify(input.attachments) : null;
    if (admitted.message !== input.message
      || (admitted.display_message || admitted.message) !== displayMessage
      || admitted.permission_mode !== (input.permissionMode ?? 'full')
      || admitted.attachments_json !== attachmentsJson
      || admitted.root_turn_id !== (input.rootTurnId ?? null)
      || admitted.brief_json !== (input.brief ? JSON.stringify(input.brief) : null)) {
      throw error;
    }
    return admitted;
  }
}
