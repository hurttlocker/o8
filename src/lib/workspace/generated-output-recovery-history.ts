import { getSqlite } from '@/lib/db';
import type { GeneratedOutputRecovery } from './generated-output-state';

/** History survives current-operation changes; creation purpose cannot be promoted. */
export function recordGeneratedOutputRecoveryHistory(resourceId: string,
  previous: GeneratedOutputRecovery | undefined, next: GeneratedOutputRecovery | undefined): void {
  if (!next) {
    if (previous) throw new Error('Generated-output recovery history cannot be discarded.');
    return;
  }
  const sqlite = getSqlite();
  const row = sqlite.prepare(`SELECT payload_json FROM workspace_generated_output_recoveries
    WHERE resource_id = ? AND operation_id = ?`).get(resourceId, next.operationId) as { payload_json: string } | undefined;
  if (previous?.operationId === next.operationId) {
    if (!row || row.payload_json !== JSON.stringify(previous)) throw new Error('Recovery history changed outside current authority.');
    const immutable = (value: GeneratedOutputRecovery) => ({ operationId: value.operationId, purpose: value.purpose,
      path: value.path, parent: value.parent, ownerPid: value.ownerPid, ownerIdentity: value.ownerIdentity,
      bankDigest: value.bankDigest, createdAt: value.createdAt });
    if (JSON.stringify(immutable(previous)) !== JSON.stringify(immutable(next))
      || (previous.root && JSON.stringify(previous.root) !== JSON.stringify(next.root))
      || (previous.completedAt && previous.completedAt !== next.completedAt)
      || (previous.retirement && JSON.stringify(previous.retirement) !== JSON.stringify(next.retirement))) {
      throw new Error('Recovery immutable creation or completion receipt changed.');
    }
    const allowed: Record<GeneratedOutputRecovery['state'], GeneratedOutputRecovery['state'][]> = {
      planned: ['planned', 'restoring', 'failed-held'], restoring: ['restoring', 'complete', 'failed-held'],
      complete: ['complete', 'retired'], 'failed-held': ['failed-held'], retired: ['retired'],
    };
    if (!allowed[previous.state].includes(next.state)) throw new Error('Recovery history transition is not monotonic.');
    if (previous.state === 'retired' && JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error('Retired recovery history is immutable.');
    }
    const changed = sqlite.prepare(`UPDATE workspace_generated_output_recoveries SET state = ?, payload_json = ?
      WHERE resource_id = ? AND operation_id = ? AND payload_json = ?`)
      .run(next.state, JSON.stringify(next), resourceId, next.operationId, row.payload_json);
    if (changed.changes !== 1) throw new Error('Recovery history lost its current CAS.');
    return;
  }
  if (row || (previous && previous.state !== 'retired') || next.state !== 'planned' || next.root || next.retirement) {
    throw new Error('Recovery requires a new planned operation after recorded retirement.');
  }
  const count = sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_generated_output_recoveries WHERE resource_id = ?')
    .get(resourceId) as { count: number };
  if (count.count >= 16) throw new Error('Recovery operation history reached its bounded limit.');
  if (previous) {
    const prior = sqlite.prepare(`SELECT payload_json FROM workspace_generated_output_recoveries
      WHERE resource_id = ? AND operation_id = ?`).get(resourceId, previous.operationId) as { payload_json: string } | undefined;
    if (prior?.payload_json !== JSON.stringify(previous)) throw new Error('Prior recovery retirement is missing.');
  }
  sqlite.prepare(`INSERT INTO workspace_generated_output_recoveries
    (resource_id, operation_id, purpose, state, payload_json) VALUES (?, ?, ?, 'planned', ?)`)
    .run(resourceId, next.operationId, next.purpose, JSON.stringify(next));
}

export function readGeneratedOutputRecoveryHistory(resourceId: string, operationId: string): GeneratedOutputRecovery | null {
  const row = getSqlite().prepare(`SELECT purpose, state, payload_json FROM workspace_generated_output_recoveries
    WHERE resource_id = ? AND operation_id = ?`).get(resourceId, operationId) as {
      purpose: string; state: string; payload_json: string;
    } | undefined;
  if (!row) return null;
  if (Buffer.byteLength(row.payload_json) > 16 * 1024 ** 2) throw new Error('Recovery history exceeds its bound.');
  const value = JSON.parse(row.payload_json) as GeneratedOutputRecovery;
  if (value.operationId !== operationId || value.purpose !== row.purpose || value.state !== row.state) {
    throw new Error('Recovery history row has inconsistent authority.');
  }
  return value;
}
