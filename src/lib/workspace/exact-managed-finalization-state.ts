import 'server-only';

import { createHash } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { readExactWorkspaceClaim, type ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';
import { assertWorkspaceRetentionReleased } from './retention-holds';

function binding(claim: ExactWorkspaceClaimRecord) {
  const fingerprint = (claim.authority?.purgeManifest as { fingerprint?: unknown } | undefined)?.fingerprint;
  if (!['managed-retirement', 'generated-output-retirement', 'generated-output-recovery-retirement'].includes(claim.kind)
    || claim.state !== 'purging'
    || !claim.sourceIdentity || !claim.claimIdentity
    || claim.sourceIdentity.device !== claim.claimIdentity.device
    || claim.sourceIdentity.inode !== claim.claimIdentity.inode
    || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error('Exact finalization has no admitted purge identity and manifest.');
  }
  return {
    operationId: claim.operationId, kind: claim.kind, repositoryPath: claim.repositoryPath,
    worktreeId: claim.worktreeId, sourcePath: claim.sourcePath, claimPath: claim.claimPath,
    sourceIdentity: claim.sourceIdentity, claimIdentity: claim.claimIdentity,
    parentIdentity: claim.parentIdentity, contentDigest: claim.contentDigest,
    purgeFingerprint: fingerprint,
    authoritySha256: createHash('sha256').update(JSON.stringify(claim.authority)).digest('hex'),
  };
}

export interface ExactManagedFinalizationReceipt {
  schema: 'o8/exact-managed-finalization/v1';
  binding: ReturnType<typeof binding>;
  state: 'admitted' | 'complete';
  admittedAt: number;
  completedAt: number | null;
  outcome: 'removed' | 'absent-after-admission' | null;
}

interface FinalizationRow {
  operation_id: string;
  kind: string;
  repository_path: string;
  worktree_id: string;
  state: string;
  receipt_json: string;
  admitted_at: number;
  completed_at: number | null;
}

/** Keep the fresh claim binding distinct from a receipt-like filesystem name. */
export function assertExactManagedFinalizationClaim(claim: ExactWorkspaceClaimRecord): ExactWorkspaceClaimRecord {
  const current = readExactWorkspaceClaim(claim.kind, claim.repositoryPath, claim.worktreeId);
  if (!current || JSON.stringify(binding(current)) !== JSON.stringify(binding(claim))) {
    throw new Error('Exact managed retirement lost its owning purge claim before final removal.');
  }
  return current;
}

/** Receipts survive claim removal and remain bound to the exact original operation. */
export function readExactManagedFinalization(
  claim: ExactWorkspaceClaimRecord,
): ExactManagedFinalizationReceipt | null {
  const row = getSqlite().prepare(
    'SELECT * FROM workspace_exact_finalizations WHERE operation_id = ?',
  ).get(claim.operationId) as FinalizationRow | undefined;
  if (!row) return null;
  const receipt = JSON.parse(row.receipt_json) as ExactManagedFinalizationReceipt;
  if (row.kind !== claim.kind || row.repository_path !== claim.repositoryPath
    || row.worktree_id !== claim.worktreeId || receipt.schema !== 'o8/exact-managed-finalization/v1'
    || JSON.stringify(receipt.binding) !== JSON.stringify(binding(claim))
    || receipt.state !== row.state || receipt.admittedAt !== row.admitted_at
    || receipt.completedAt !== row.completed_at || !Number.isSafeInteger(receipt.admittedAt)
    || (receipt.state === 'admitted' && (receipt.completedAt !== null || receipt.outcome !== null))
    || (receipt.state === 'complete' && (!Number.isSafeInteger(receipt.completedAt)
      || !['removed', 'absent-after-admission'].includes(receipt.outcome ?? '')))) {
    throw new Error('Exact finalization receipt does not match its owning claim.');
  }
  return receipt;
}

/** Called only after native content release, fresh ownership, and an exact empty check. */
export function admitExactManagedFinalization(claim: ExactWorkspaceClaimRecord): ExactManagedFinalizationReceipt {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const current = assertExactManagedFinalizationClaim(claim);
    assertWorkspaceRetentionReleased(current.sourcePath, current.sourceIdentity ?? undefined);
    const existing = readExactManagedFinalization(current);
    if (existing?.state === 'complete') {
      throw new Error('An already completed exact finalization namespace returned.');
    }
    if (existing) return existing;
    const receipt: ExactManagedFinalizationReceipt = {
      schema: 'o8/exact-managed-finalization/v1', binding: binding(current), state: 'admitted',
      admittedAt: Date.now(), completedAt: null, outcome: null,
    };
    sqlite.prepare(`
      INSERT INTO workspace_exact_finalizations (
        operation_id, kind, repository_path, worktree_id, state, receipt_json, admitted_at, completed_at
      ) VALUES (?, ?, ?, ?, 'admitted', ?, ?, NULL)
    `).run(current.operationId, current.kind, current.repositoryPath, current.worktreeId,
      JSON.stringify(receipt), receipt.admittedAt);
    return readExactManagedFinalization(current)!;
  }).immediate();
}

/** Record the actual removal result or a fresh absent-path observation after admission. */
export function completeExactManagedFinalization(
  claim: ExactWorkspaceClaimRecord,
  outcome: 'removed' | 'absent-after-admission',
): ExactManagedFinalizationReceipt {
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const current = assertExactManagedFinalizationClaim(claim);
    assertWorkspaceRetentionReleased(current.sourcePath, current.sourceIdentity ?? undefined);
    const admitted = readExactManagedFinalization(current);
    if (!admitted) throw new Error('Exact retirement has no durable final-empty admission.');
    if (admitted.state === 'complete') return admitted;
    const receipt: ExactManagedFinalizationReceipt = {
      ...admitted, state: 'complete', completedAt: Date.now(), outcome,
    };
    const result = sqlite.prepare(`
      UPDATE workspace_exact_finalizations SET state = 'complete', receipt_json = ?, completed_at = ?
      WHERE operation_id = ? AND state = 'admitted' AND receipt_json = ?
    `).run(JSON.stringify(receipt), receipt.completedAt, current.operationId, JSON.stringify(admitted));
    if (result.changes !== 1) throw new Error('Exact finalization completion lost its durable CAS.');
    return readExactManagedFinalization(current)!;
  }).immediate();
}
