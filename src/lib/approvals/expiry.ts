import { getSqlite } from '@/lib/db';
import { isOperatorDispatcherApproval } from './inbox-visibility';
import { resolveApproval } from './resolution';
import type { ApprovalRecord } from './types';

const STALE_APPROVAL_TTL_MS = 1000 * 60 * 30;

export const STALE_APPROVAL_EXPIRY_NOTE = 'Expired: stale pending approval TTL exceeded';

function parseArgs(value: string | null): ApprovalRecord['args'] {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as ApprovalRecord['args'];
  } catch {
    return undefined;
  }
}

export function isStaleApprovalExpiryResolution(
  status: string,
  resolutionJson: string | null,
): boolean {
  if (status !== 'rejected' || !resolutionJson) return false;
  try {
    const resolution = JSON.parse(resolutionJson) as { actor?: unknown; note?: unknown };
    return resolution.actor === 'system' && resolution.note === STALE_APPROVAL_EXPIRY_NOTE;
  } catch {
    return false;
  }
}

export function expireStaleApprovals(): number {
  const cutoff = Date.now() - STALE_APPROVAL_TTL_MS;
  const sqlite = getSqlite();
  const stale = sqlite
    .prepare(`
      SELECT id, args_json, lane_id FROM approvals
      WHERE status = 'pending'
        AND created_at < ?
    `)
    .all(cutoff) as Array<{ id: string; args_json: string | null; lane_id: string | null }>;

  let changes = 0;
  for (const row of stale) {
    const lane = row.lane_id
      ? sqlite.prepare('SELECT status FROM lanes WHERE id = ?').get(row.lane_id) as { status: string } | undefined
      : undefined;
    if (
      isOperatorDispatcherApproval({ args: parseArgs(row.args_json) })
      && lane
      && lane.status !== 'completed'
      && lane.status !== 'archived'
    ) continue;
    const resolved = resolveApproval(row.id, 'reject', 'system', STALE_APPROVAL_EXPIRY_NOTE);
    if (resolved) changes += 1;
  }

  if (changes > 0) {
    console.log(`[approvals] Expired ${changes} stale pending approvals`);
  }
  return changes;
}
