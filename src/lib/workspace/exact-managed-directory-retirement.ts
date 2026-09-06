import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { purgeExactDirectory } from './exact-directory-purge';
import { renameExactChildDirectory } from './exact-parent-operation';
import {
  listExactWorkspaceClaims,
  prepareExactWorkspaceClaim,
  readExactWorkspaceClaim,
  removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim,
  type ExactWorkspaceClaimRecord,
} from './exact-workspace-claim-state';

export interface ExactManagedDirectoryRetirementInput {
  repositoryPath: string;
  worktreeId: string;
  directoryPath: string;
  identity: WorktreeMaterializationIdentity;
  parentIdentity?: WorktreeMaterializationIdentity;
  beforeRetirementRename?: () => Promise<void>;
  afterRetirementRename?: () => Promise<void>;
}

function sameIdentity(
  left: { device: number; inode: number },
  right: { device: number; inode: number },
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function captureParentIdentity(directoryPath: string): Promise<WorktreeMaterializationIdentity> {
  const parentPath = path.dirname(path.resolve(directoryPath));
  const stat = await lstat(parentPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Exact managed retirement parent is not a regular directory.');
  }
  return { device: stat.dev, inode: stat.ino, canonicalPath: await realpath(parentPath) };
}

async function directoryIdentity(
  candidatePath: string,
): Promise<{ device: number; inode: number } | null> {
  const stat = await lstat(candidatePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Exact managed retirement found a non-directory occupant.');
  }
  return { device: stat.dev, inode: stat.ino };
}

function sourceCanonicalPath(claim: ExactWorkspaceClaimRecord): string {
  const candidate = claim.authority?.sourceCanonicalPath;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('Exact managed retirement claim has invalid canonical authority.');
  }
  return candidate;
}

function sourceIdentity(claim: ExactWorkspaceClaimRecord): WorktreeMaterializationIdentity {
  if (!claim.sourceIdentity) {
    throw new Error('Exact managed retirement claim has no source identity.');
  }
  return { ...claim.sourceIdentity, canonicalPath: sourceCanonicalPath(claim) };
}

function verifyClaimInput(
  claim: ExactWorkspaceClaimRecord,
  input: ExactManagedDirectoryRetirementInput,
  parentIdentity: WorktreeMaterializationIdentity,
): void {
  const directoryPath = path.join(
    parentIdentity.canonicalPath,
    path.basename(path.resolve(input.directoryPath)),
  );
  if (claim.expectedPath !== directoryPath || claim.sourcePath !== directoryPath
    || !claim.sourceIdentity || !sameIdentity(claim.sourceIdentity, input.identity)
    || sourceCanonicalPath(claim) !== input.identity.canonicalPath
    || claim.parentIdentity.device !== parentIdentity.device
    || claim.parentIdentity.inode !== parentIdentity.inode
    || claim.parentIdentity.canonicalPath !== parentIdentity.canonicalPath
    || path.dirname(claim.claimPath) !== parentIdentity.canonicalPath) {
    throw new Error('Exact managed retirement conflicts with trusted durable authority.');
  }
}

async function prepareRetirement(
  input: ExactManagedDirectoryRetirementInput,
): Promise<ExactWorkspaceClaimRecord | null> {
  const requestedDirectoryPath = path.resolve(input.directoryPath);
  const parentIdentity = await captureParentIdentity(requestedDirectoryPath);
  const directoryPath = path.join(
    parentIdentity.canonicalPath,
    path.basename(requestedDirectoryPath),
  );
  if (input.parentIdentity
    && (parentIdentity.device !== input.parentIdentity.device
      || parentIdentity.inode !== input.parentIdentity.inode
      || parentIdentity.canonicalPath !== input.parentIdentity.canonicalPath)) {
    throw new Error('Exact managed retirement parent ownership changed after admission.');
  }
  if (path.dirname(input.identity.canonicalPath) !== parentIdentity.canonicalPath) {
    throw new Error('Exact managed retirement canonical ownership escapes its parent.');
  }
  const existing = readExactWorkspaceClaim(
    'managed-retirement', input.repositoryPath, input.worktreeId,
  );
  if (existing) {
    verifyClaimInput(existing, input, parentIdentity);
    return existing;
  }
  if (!(await directoryIdentity(directoryPath))) return null;
  await assertWorktreeMaterializationIdentity(directoryPath, input.identity);
  const operationId = randomUUID();
  const claimPath = path.join(parentIdentity.canonicalPath, `.o8-retired-managed-${operationId}`);
  const contentDigest = createHash('sha256').update(JSON.stringify({
    directoryPath,
    identity: input.identity,
    parentIdentity,
  })).digest('hex');
  return prepareExactWorkspaceClaim({
    kind: 'managed-retirement',
    repositoryPath: input.repositoryPath,
    worktreeId: input.worktreeId,
    operationId,
    expectedPath: directoryPath,
    sourcePath: directoryPath,
    claimPath,
    parentIdentity,
    sourceIdentity: input.identity,
    contentDigest,
    authority: { sourceCanonicalPath: input.identity.canonicalPath },
  });
}

async function finishClaim(
  initial: ExactWorkspaceClaimRecord,
  beforeRetirementRename?: () => Promise<void>,
  afterRetirementRename?: () => Promise<void>,
): Promise<void> {
  let claim = initial;
  await assertWorktreeMaterializationIdentity(
    path.dirname(claim.sourcePath), claim.parentIdentity,
  );
  const expected = sourceIdentity(claim);
  const original = await directoryIdentity(claim.sourcePath);
  const retired = await directoryIdentity(claim.claimPath);
  if (original && retired) throw new Error('Exact managed retirement found both source and claim.');
  if (original && !sameIdentity(original, expected)) {
    throw new Error('Exact managed retirement refused a replacement at the source path.');
  }
  if (retired && !sameIdentity(retired, expected)) {
    throw new Error('Exact managed retirement refused a replacement at the claim path.');
  }

  if (claim.state === 'prepared') {
    if (original) {
      await beforeRetirementRename?.();
      await renameExactChildDirectory(
        path.dirname(claim.sourcePath), claim.parentIdentity,
        claim.sourcePath, claim.claimPath, expected,
      );
      await afterRetirementRename?.();
    } else if (!retired) {
      throw new Error('Exact managed retirement lost both prepared namespaces.');
    }
    claim = transitionExactWorkspaceClaim({
      kind: 'managed-retirement',
      repositoryPath: claim.repositoryPath,
      worktreeId: claim.worktreeId,
      operationId: claim.operationId,
      expectedState: 'prepared',
      toState: 'claimed',
      claimIdentity: expected,
    });
  }
  if (claim.state === 'claimed') {
    if (!claim.claimIdentity || !sameIdentity(claim.claimIdentity, expected)) {
      throw new Error('Exact managed retirement claim identity is missing or changed.');
    }
    claim = transitionExactWorkspaceClaim({
      kind: 'managed-retirement',
      repositoryPath: claim.repositoryPath,
      worktreeId: claim.worktreeId,
      operationId: claim.operationId,
      expectedState: 'claimed',
      toState: 'purging',
    });
  }
  if (claim.state !== 'purging') {
    throw new Error(`Exact managed retirement has unsupported state ${claim.state}.`);
  }
  const remainingSource = await directoryIdentity(claim.sourcePath);
  const remainingClaim = await directoryIdentity(claim.claimPath);
  if (remainingSource) throw new Error('Exact managed retirement source reappeared during purge.');
  if (remainingClaim) {
    if (!sameIdentity(remainingClaim, expected)) {
      throw new Error('Exact managed retirement claim changed before purge.');
    }
    await purgeExactDirectory(claim.claimPath, expected);
  }
}

/** Retire only authority first persisted in the trusted SQLite claim ledger. */
export async function retireExactManagedDirectory(
  input: ExactManagedDirectoryRetirementInput,
): Promise<void> {
  const claim = await prepareRetirement(input);
  if (!claim) return;
  await finishClaim(claim, input.beforeRetirementRename, input.afterRetirementRename);
}

/** Remove durable authority only after the caller has removed managed metadata. */
export function completeExactManagedDirectoryRetirement(
  repositoryPath: string,
  worktreeId: string,
): void {
  const claim = readExactWorkspaceClaim('managed-retirement', repositoryPath, worktreeId);
  if (!claim) return;
  if (claim.state !== 'purging') {
    throw new Error('Exact managed retirement cannot complete before exact purge.');
  }
  removeExactWorkspaceClaim('managed-retirement', repositoryPath, worktreeId, claim.operationId);
}

/** Resume only SQLite-backed retirements; receipt-like files are never authority. */
export async function finishPendingExactManagedDirectoryRetirements(
  repositoryPath: string,
  parentPath: string,
  parentIdentity: WorktreeMaterializationIdentity,
  canFinalize?: (worktreeId: string) => boolean,
): Promise<{ completed: number; refused: number }> {
  await assertWorktreeMaterializationIdentity(path.resolve(parentPath), parentIdentity);
  const resolvedParent = parentIdentity.canonicalPath;
  let completed = 0;
  let refused = 0;
  for (const claim of listExactWorkspaceClaims('managed-retirement', repositoryPath)) {
    if (path.dirname(claim.sourcePath) !== resolvedParent
      || claim.parentIdentity.device !== parentIdentity.device
      || claim.parentIdentity.inode !== parentIdentity.inode
      || claim.parentIdentity.canonicalPath !== parentIdentity.canonicalPath) continue;
    try {
      await finishClaim(claim);
      if (canFinalize?.(claim.worktreeId)) {
        completeExactManagedDirectoryRetirement(repositoryPath, claim.worktreeId);
      }
      completed += 1;
    } catch {
      refused += 1;
    }
  }
  return { completed, refused };
}
