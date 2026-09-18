import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { recordLaneEvent } from '@/lib/lane/events';
import type { JudgmentReceipt } from './types';

export type JudgmentReceiptInput = Omit<JudgmentReceipt, 'id' | 'createdAt'>;

interface ReceiptRow {
  id: string;
  provider: string;
  model: string | null;
  ok: number;
  questions_json: string;
  answers_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
  attempts: number;
  truncated: number;
  hidden_text: number;
  error_json: string | null;
  packet_id: string | null;
  lane_id: string | null;
  approval_id: string | null;
  surface: string | null;
  created_at: string;
  route: string | null;
}

function insertReceiptRow(receipt: JudgmentReceipt): void {
  getSqlite().prepare(`
    INSERT INTO judgment_receipts (
      id, provider, model, ok, questions_json, answers_json, input_tokens, output_tokens,
      latency_ms, attempts, truncated, hidden_text, error_json, packet_id, lane_id, approval_id, surface, created_at, route
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    receipt.id,
    receipt.provider,
    receipt.model,
    receipt.ok ? 1 : 0,
    JSON.stringify(receipt.questions),
    receipt.answers ? JSON.stringify(receipt.answers) : null,
    receipt.inputTokens,
    receipt.outputTokens,
    receipt.latencyMs,
    receipt.attempts,
    receipt.truncated ? 1 : 0,
    receipt.hiddenText ? 1 : 0,
    receipt.error ? JSON.stringify(receipt.error) : null,
    receipt.packetId,
    receipt.laneId,
    receipt.approvalId,
    receipt.surface,
    receipt.createdAt,
    receipt.route,
  );
}

let receiptWriteFailureReported = false;

/**
 * Report a failed receipt insert once per process, with the columns the table
 * actually has (#2459). A per-call warning says the same thing forever and
 * still leaves the next report guessing; the column list names the drift.
 */
function reportReceiptWriteFailureOnce(error: unknown): void {
  if (receiptWriteFailureReported) return;
  receiptWriteFailureReported = true;
  let columns = 'unreadable';
  try {
    columns = (getSqlite().prepare('PRAGMA table_info(judgment_receipts)').all() as Array<{ name: string }>)
      .map((entry) => entry.name).join(', ') || 'none';
  } catch { /* the column list is a diagnostic; never let reading it mask the failure */ }
  console.error(
    '[judgment] receipt write failed, silenced for the rest of this process:',
    error instanceof Error ? error.message : error,
    `| judgment_receipts columns: ${columns}`,
  );
}

/**
 * Persist one call's receipt: a `judgment` lane event when a lane is in
 * context, otherwise (or if the lane write fails) a `judgment_receipts` row.
 * Never throws; returns the receipt id, or null when both writes failed.
 */
export function recordJudgmentReceipt(input: JudgmentReceiptInput): string | null {
  const receipt: JudgmentReceipt = { ...input, id: `jdg_${randomUUID()}`, createdAt: new Date().toISOString() };
  if (receipt.laneId) {
    try {
      const { id, laneId: _laneId, ...payload } = receipt;
      recordLaneEvent(receipt.laneId, 'judgment', 'system', { receiptId: id, ...payload });
      return receipt.id;
    } catch (error) {
      console.warn('[judgment] lane receipt failed, writing a receipt row instead:', error instanceof Error ? error.message : error);
    }
  }
  try {
    insertReceiptRow(receipt);
    return receipt.id;
  } catch (error) {
    reportReceiptWriteFailureOnce(error);
    return null;
  }
}

function fromRow(row: ReceiptRow): JudgmentReceipt {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    ok: row.ok === 1,
    questions: JSON.parse(row.questions_json) as JudgmentReceipt['questions'],
    answers: row.answers_json ? JSON.parse(row.answers_json) as Record<string, unknown> : null,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    attempts: row.attempts,
    truncated: row.truncated === 1,
    hiddenText: row.hidden_text === 1,
    error: row.error_json ? JSON.parse(row.error_json) as JudgmentReceipt['error'] : null,
    packetId: row.packet_id,
    laneId: row.lane_id,
    approvalId: row.approval_id,
    surface: row.surface,
    route: row.route === 'direct' || row.route === 'managed' ? row.route : null,
    createdAt: row.created_at,
  };
}

/** Receipt rows (not lane events), newest first. */
export function listJudgmentReceipts(filter: { packetId?: string; approvalId?: string; limit?: number } = {}): JudgmentReceipt[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.packetId) { where.push('packet_id = ?'); args.push(filter.packetId); }
  if (filter.approvalId) { where.push('approval_id = ?'); args.push(filter.approvalId); }
  const rows = getSqlite().prepare(`
    SELECT * FROM judgment_receipts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(...args, filter.limit ?? 50) as ReceiptRow[];
  return rows.map(fromRow);
}
