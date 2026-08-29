import { getSqlite } from '@/lib/db';
import type { TerminalReviewQueueEvidence } from '@/lib/terminal-status/resolve';

export function listTerminalReviewQueueEvidence(): TerminalReviewQueueEvidence[] {
  const rows = getSqlite().prepare(
    `SELECT id, lane_id, status, updated_at, last_error
     FROM review_queue
     WHERE status IN ('pending', 'in_progress')`,
  ).all() as Array<{
    id: string;
    lane_id: string;
    status: TerminalReviewQueueEvidence['status'];
    updated_at: string;
    last_error: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    laneId: row.lane_id,
    status: row.status,
    updatedAt: row.updated_at.includes('T') ? row.updated_at : `${row.updated_at.replace(' ', 'T')}Z`,
    lastError: row.last_error,
  }));
}
