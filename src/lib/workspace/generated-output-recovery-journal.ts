import { getSqlite } from '@/lib/db';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { readGeneratedOutputResource, type GeneratedOutputResource } from './generated-output-state';

export type RecoveryWritePhase = 'planned' | 'ready' | 'prepared' | 'written' | 'complete';
export interface RecoveryWriteReceipt {
  pid: number;
  processIdentity: MetadataLockProcessIdentity;
  device?: number;
  inode?: number;
}

/** Complete means the native file writer actually closed successfully. */
export function recordRecoveryEntry(resource: GeneratedOutputResource, relative: string,
  kind: 'directory' | 'file', phase: RecoveryWritePhase,
  identity?: { device?: number; inode?: number; canonicalPath?: string }, receipt?: RecoveryWriteReceipt): void {
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const current = readGeneratedOutputResource(resource.resourceId);
    if (!current || current.version !== resource.version || current.recovery?.operationId !== resource.recovery?.operationId
      || !['planned', 'restoring'].includes(current.recovery!.state)
      || !current.bank?.entries.some(entry => entry.relative === relative && entry.kind === kind)) {
      throw new Error('Recovery resource authority changed.');
    }
    const key = [resource.resourceId, current.recovery!.operationId, relative];
    const prior = sqlite.prepare(`SELECT phase, kind, receipt_json, device, inode FROM workspace_generated_output_recovery_entries
      WHERE resource_id = ? AND operation_id = ? AND relative = ?`).get(...key) as {
        phase: RecoveryWritePhase; kind: string; receipt_json: string | null; device: number | null; inode: number | null;
      } | undefined;
    const order: RecoveryWritePhase[] = kind === 'file'
      ? ['planned', 'ready', 'prepared', 'written', 'complete'] : ['planned', 'complete'];
    if (phase !== order[prior ? order.indexOf(prior.phase) + 1 : 0] || (prior && prior.kind !== kind)) {
      throw new Error('Recovery journal sequence changed.');
    }
    if (kind === 'file' && phase !== 'planned') {
      if (!receipt || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || !receipt.processIdentity) {
        throw new Error('Recovery file has no native child birth receipt.');
      }
      const previous = prior?.receipt_json ? JSON.parse(prior.receipt_json) as RecoveryWriteReceipt : null;
      if (previous && (previous.pid !== receipt.pid
        || JSON.stringify(previous.processIdentity) !== JSON.stringify(receipt.processIdentity)
        || (previous.device !== undefined && (previous.device !== receipt.device || previous.inode !== receipt.inode)))) {
        throw new Error('Recovery child or inode identity changed.');
      }
      if (phase === 'complete' && prior!.receipt_json !== JSON.stringify(receipt)) {
        throw new Error('Recovery close differs from its written receipt.');
      }
    }
    if (['prepared', 'written', 'complete'].includes(phase)
      && (!identity || !Number.isSafeInteger(identity.device) || !Number.isSafeInteger(identity.inode) || identity.inode! <= 0)) {
      throw new Error('Recovery namespace lacks an exact inode receipt.');
    }
    if (!prior) {
      sqlite.prepare(`INSERT INTO workspace_generated_output_recovery_entries
        (resource_id, operation_id, relative, kind, phase, device, inode, canonical_path,
          receipt_json, observed_closed, exit_code) VALUES (?, ?, ?, ?, 'planned', NULL, NULL, NULL, NULL, 0, NULL)`)
        .run(...key, kind);
    } else {
      const result = sqlite.prepare(`UPDATE workspace_generated_output_recovery_entries SET phase = ?, device = ?, inode = ?,
        canonical_path = ?, receipt_json = ?, observed_closed = ?, exit_code = ?
        WHERE resource_id = ? AND operation_id = ? AND relative = ? AND phase = ?`)
        .run(phase, identity?.device ?? null, identity?.inode ?? null, identity?.canonicalPath ?? null,
          receipt ? JSON.stringify(receipt) : null, phase === 'complete' ? 1 : 0, phase === 'complete' ? 0 : null,
          ...key, prior.phase);
      if (result.changes !== 1) throw new Error('Recovery lost its trusted journal CAS.');
    }
  }).immediate();
}
