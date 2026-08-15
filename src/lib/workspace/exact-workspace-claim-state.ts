import 'server-only';

import { createRequire } from 'node:module';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export type ExactWorkspaceClaimKind =
  | 'restore-creation'
  | 'worktree-quarantine'
  | 'managed-retirement';
export type ExactWorkspaceClaimState = 'prepared' | 'claimed' | 'published' | 'purging';

export interface ExactWorkspaceClaimRecord {
  kind: ExactWorkspaceClaimKind;
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  expectedPath: string;
  sourcePath: string;
  claimPath: string;
  state: ExactWorkspaceClaimState;
  parentIdentity: WorktreeMaterializationIdentity;
  sourceIdentity: { device: number; inode: number } | null;
  claimIdentity: { device: number; inode: number } | null;
  contentDigest: string | null;
  authority: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

interface ExactWorkspaceClaimRow {
  kind: string;
  repository_path: string;
  worktree_id: string;
  operation_id: string;
  expected_path: string;
  source_path: string;
  claim_path: string;
  state: string;
  parent_device: number;
  parent_inode: number;
  parent_canonical_path: string;
  source_device: number | null;
  source_inode: number | null;
  claim_device: number | null;
  claim_inode: number | null;
  content_digest: string | null;
  authority_json: string | null;
  created_at: number;
  updated_at: number;
}

function decode(row: ExactWorkspaceClaimRow): ExactWorkspaceClaimRecord {
  return {
    kind: row.kind as ExactWorkspaceClaimKind,
    repositoryPath: row.repository_path,
    worktreeId: row.worktree_id,
    operationId: row.operation_id,
    expectedPath: row.expected_path,
    sourcePath: row.source_path,
    claimPath: row.claim_path,
    state: row.state as ExactWorkspaceClaimState,
    parentIdentity: {
      device: row.parent_device,
      inode: row.parent_inode,
      canonicalPath: row.parent_canonical_path,
    },
    sourceIdentity: row.source_device === null || row.source_inode === null
      ? null : { device: row.source_device, inode: row.source_inode },
    claimIdentity: row.claim_device === null || row.claim_inode === null
      ? null : { device: row.claim_device, inode: row.claim_inode },
    contentDigest: row.content_digest,
    authority: row.authority_json ? JSON.parse(row.authority_json) as Record<string, unknown> : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exactMatch(actual: ExactWorkspaceClaimRecord, expected: ExactWorkspaceClaimRecord): boolean {
  return actual.kind === expected.kind
    && actual.repositoryPath === expected.repositoryPath
    && actual.worktreeId === expected.worktreeId
    && actual.operationId === expected.operationId
    && actual.expectedPath === expected.expectedPath
    && actual.sourcePath === expected.sourcePath
    && actual.claimPath === expected.claimPath
    && actual.parentIdentity.device === expected.parentIdentity.device
    && actual.parentIdentity.inode === expected.parentIdentity.inode
    && actual.parentIdentity.canonicalPath === expected.parentIdentity.canonicalPath
    && actual.sourceIdentity?.device === expected.sourceIdentity?.device
    && actual.sourceIdentity?.inode === expected.sourceIdentity?.inode
    && actual.contentDigest === expected.contentDigest
    && JSON.stringify(actual.authority) === JSON.stringify(expected.authority);
}

export function prepareExactWorkspaceClaim(
  input: Omit<ExactWorkspaceClaimRecord, 'state' | 'sourceIdentity' | 'claimIdentity' | 'createdAt' | 'updatedAt'>
  & { sourceIdentity?: { device: number; inode: number } | null; now?: number },
): ExactWorkspaceClaimRecord {
  const now = input.now ?? Date.now();
  const candidate: ExactWorkspaceClaimRecord = {
    ...input,
    repositoryPath: path.resolve(input.repositoryPath),
    expectedPath: path.resolve(input.expectedPath),
    sourcePath: path.resolve(input.sourcePath),
    claimPath: path.resolve(input.claimPath),
    state: 'prepared',
    sourceIdentity: input.sourceIdentity ?? null,
    claimIdentity: null,
    createdAt: now,
    updatedAt: now,
  };
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT OR IGNORE INTO workspace_exact_claims (
      kind, repository_path, worktree_id, operation_id,
      expected_path, source_path, claim_path, state,
      parent_device, parent_inode, parent_canonical_path,
      source_device, source_inode, claim_device, claim_inode,
      content_digest, authority_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
  `).run(
    candidate.kind, candidate.repositoryPath, candidate.worktreeId, candidate.operationId,
    candidate.expectedPath, candidate.sourcePath, candidate.claimPath,
    candidate.parentIdentity.device, candidate.parentIdentity.inode,
    candidate.parentIdentity.canonicalPath,
    candidate.sourceIdentity?.device ?? null, candidate.sourceIdentity?.inode ?? null,
    candidate.contentDigest, candidate.authority ? JSON.stringify(candidate.authority) : null,
    now, now,
  );
  const actual = readExactWorkspaceClaim(candidate.kind, candidate.repositoryPath, candidate.worktreeId);
  if (!actual || !exactMatch(actual, candidate)) {
    throw new Error('Exact workspace claim conflicts with durable trusted authority.');
  }
  return actual;
}

export function readExactWorkspaceClaim(
  kind: ExactWorkspaceClaimKind,
  repositoryPath: string,
  worktreeId: string,
): ExactWorkspaceClaimRecord | null {
  const row = getSqlite().prepare(`
    SELECT * FROM workspace_exact_claims
    WHERE kind = ? AND repository_path = ? AND worktree_id = ?
  `).get(kind, path.resolve(repositoryPath), worktreeId) as ExactWorkspaceClaimRow | undefined;
  return row ? decode(row) : null;
}

export function bindExactWorkspaceClaimCreator(input: {
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  pid: number;
  processIdentity: MetadataLockProcessIdentity;
}): ExactWorkspaceClaimRecord {
  const current = readExactWorkspaceClaim('restore-creation', input.repositoryPath, input.worktreeId);
  if (!current || current.operationId !== input.operationId || current.state !== 'prepared') {
    throw new Error('Exact restore creator binding lost its prepared claim.');
  }
  const authority = {
    ...(current.authority ?? {}),
    creatorPid: input.pid,
    creatorProcessIdentity: input.processIdentity,
  };
  const result = getSqlite().prepare(`
    UPDATE workspace_exact_claims SET authority_json = ?, updated_at = ?
    WHERE kind = 'restore-creation' AND repository_path = ? AND worktree_id = ?
      AND operation_id = ? AND state = 'prepared'
  `).run(
    JSON.stringify(authority), Date.now(), path.resolve(input.repositoryPath),
    input.worktreeId, input.operationId,
  );
  if (result.changes !== 1) throw new Error('Exact restore creator binding lost its trusted CAS.');
  return readExactWorkspaceClaim(
    'restore-creation', input.repositoryPath, input.worktreeId,
  )!;
}

export function listExactWorkspaceClaims(
  kind: ExactWorkspaceClaimKind,
  repositoryPath: string,
): ExactWorkspaceClaimRecord[] {
  return (getSqlite().prepare(`
    SELECT * FROM workspace_exact_claims
    WHERE kind = ? AND repository_path = ? ORDER BY created_at ASC
  `).all(kind, path.resolve(repositoryPath)) as ExactWorkspaceClaimRow[]).map(decode);
}

export function transitionExactWorkspaceClaim(input: {
  kind: ExactWorkspaceClaimKind;
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  expectedState: ExactWorkspaceClaimState;
  toState: ExactWorkspaceClaimState;
  claimIdentity?: { device: number; inode: number } | null;
  now?: number;
}): ExactWorkspaceClaimRecord {
  const now = input.now ?? Date.now();
  const result = getSqlite().prepare(`
    UPDATE workspace_exact_claims SET
      state = ?,
      claim_device = COALESCE(?, claim_device),
      claim_inode = COALESCE(?, claim_inode),
      updated_at = ?
    WHERE kind = ? AND repository_path = ? AND worktree_id = ?
      AND operation_id = ? AND state = ?
  `).run(
    input.toState,
    input.claimIdentity?.device ?? null,
    input.claimIdentity?.inode ?? null,
    now,
    input.kind,
    path.resolve(input.repositoryPath),
    input.worktreeId,
    input.operationId,
    input.expectedState,
  );
  const current = readExactWorkspaceClaim(input.kind, input.repositoryPath, input.worktreeId);
  if (result.changes !== 1 && (current?.operationId !== input.operationId
    || current.state !== input.toState
    || (input.claimIdentity && (current.claimIdentity?.device !== input.claimIdentity.device
      || current.claimIdentity.inode !== input.claimIdentity.inode)))) {
    throw new Error('Exact workspace claim transition lost its trusted CAS.');
  }
  if (!current) throw new Error('Exact workspace claim disappeared after transition.');
  return current;
}

export function removeExactWorkspaceClaim(
  kind: ExactWorkspaceClaimKind,
  repositoryPath: string,
  worktreeId: string,
  operationId: string,
): void {
  const result = getSqlite().prepare(`
    DELETE FROM workspace_exact_claims
    WHERE kind = ? AND repository_path = ? AND worktree_id = ? AND operation_id = ?
  `).run(kind, path.resolve(repositoryPath), worktreeId, operationId);
  if (result.changes > 1) throw new Error('Exact workspace claim removal changed multiple rows.');
}

/** Child-only CAS config; the child never receives a filesystem capability. */
export function exactWorkspaceClaimChildAuthority(): {
  sqliteModulePath: string;
  databasePath: string;
} {
  const sqlite = getSqlite();
  return {
    sqliteModulePath: createRequire(import.meta.url).resolve('better-sqlite3'),
    databasePath: sqlite.name,
  };
}
