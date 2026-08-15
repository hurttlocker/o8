import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { WorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import type { ExactRestoreWorktreeInput, PreparedRestoreRecoveryInput } from './worktree-exact';
import { purgeExactDirectory } from './exact-directory-purge';
import {
  exactWorkspaceClaimChildAuthority,
  prepareExactWorkspaceClaim,
  readExactWorkspaceClaim,
  removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim,
  type ExactWorkspaceClaimRecord,
} from './exact-workspace-claim-state';
import {
  createExactChildDirectoryWithReceipt,
  removeExactUnreceiptedEmptyChildDirectory,
  renameExactChildDirectory,
} from './exact-parent-operation';
import {
  captureDestructiveDirectoryIdentity,
  captureGitWorktreeAdminIdentity,
  cleanupExactGitWorktreeAdmin,
  recoverGitWorktreeAdminReceipt,
  verifyDestructiveDirectoryIdentity,
  type DestructiveDirectoryIdentity,
} from './worktree-exact-identity';

const execFileAsync = promisify(execFile);

const RESTORE_TARGET_POPULATOR = String.raw`
const { spawnSync } = require('node:child_process');
const commands = JSON.parse(process.argv[1]);
for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    cwd: '.',
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Restore target population failed.\n');
    process.exit(result.status || 1);
  }
}
`;

type RestorePreparation = NonNullable<WorktreeMetaEntry['restorePreparation']>;
type RestoreAdminReceipt = NonNullable<RestorePreparation['gitAdminIdentity']>;

async function runOwnedTargetCommands(
  targetPath: string,
  identity: WorktreeMaterializationIdentity,
  commands: Array<[string, string[]]>,
  afterCommand?: (completedCommands: number) => Promise<void>,
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    const invocation = guardedWorkspaceInvocation(
      process.execPath,
      ['-e', RESTORE_TARGET_POPULATOR, JSON.stringify([command])],
      identity,
    );
    await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      cwd: targetPath,
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await afterCommand?.(index + 1);
  }
}

async function pathIsAbsent(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => false, (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  });
}

function identityMatches(
  before: DestructiveDirectoryIdentity,
  after: DestructiveDirectoryIdentity,
): boolean {
  const beforeLeaf = before.entries[0];
  const afterLeaf = after.entries[0];
  return Boolean(beforeLeaf && afterLeaf
    && beforeLeaf.device === afterLeaf.device
    && beforeLeaf.inode === afterLeaf.inode
    && before.entries.slice(1).every((entry, index) => {
      const current = after.entries[index + 1];
      return current && entry.device === current.device && entry.inode === current.inode
        && entry.canonicalPath === current.canonicalPath && entry.kind === current.kind;
    }));
}

function metadataMatchesPreparation(
  metadata: WorktreeMetaEntry | undefined,
  input: PreparedRestoreRecoveryInput,
  expectedPath: string,
): boolean {
  const preparation = metadata?.restorePreparation;
  return Boolean(preparation
    && path.resolve(preparation.expectedPath) === expectedPath
    && preparation.head === input.head
    && preparation.tree === input.tree
    && preparation.isolationKind === input.isolationKind
    && typeof preparation.claimOperationId === 'string');
}

function metadataMatchesIdentity(
  metadata: WorktreeMetaEntry | undefined,
  identity: DestructiveDirectoryIdentity,
  expectedCanonicalPath: string,
): boolean {
  const leaf = identity.entries[0];
  return Boolean(metadata?.materializationIdentity && leaf
    && metadata.materializationIdentity.device === leaf.device
    && metadata.materializationIdentity.inode === leaf.inode
    && metadata.materializationIdentity.canonicalPath === expectedCanonicalPath);
}

function materializationIdentity(
  identity: DestructiveDirectoryIdentity,
): WorktreeMaterializationIdentity {
  const leaf = identity.entries[0]!;
  return { device: leaf.device, inode: leaf.inode, canonicalPath: identity.canonicalPath };
}

function adminCleanupReceipt(receipt: RestoreAdminReceipt): {
  gitAdminPath: string;
  gitAdminDevice: number;
  gitAdminInode: number;
} {
  return {
    gitAdminPath: receipt.path,
    gitAdminDevice: receipt.device,
    gitAdminInode: receipt.inode,
  };
}

function trustedClaim(
  metadata: WorktreeMetaEntry,
  repoPath: string,
  expectedPath: string,
): ExactWorkspaceClaimRecord {
  const operationId = metadata.restorePreparation?.claimOperationId;
  const claim = readExactWorkspaceClaim('restore-creation', repoPath, metadata.id);
  if (!claim || !operationId || claim.operationId !== operationId
    || claim.expectedPath !== expectedPath
    || claim.claimPath !== path.resolve(metadata.restorePreparation!.stagePath)) {
    throw new Error('Exact restore is missing its trusted SQLite claim authority.');
  }
  return claim;
}

async function verifyGitTruth(
  workspacePath: string,
  input: ExactRestoreWorktreeInput,
  identity: WorktreeMaterializationIdentity,
): Promise<void> {
  const run = async (args: string[]): Promise<string> => {
    const invocation = guardedWorkspaceInvocation('git', args, identity);
    return execFileAsync(invocation.command, invocation.args, {
      windowsHide: true, cwd: workspacePath, timeout: 5_000,
    }).then(({ stdout }) => stdout.trim());
  };
  const [branch, head, tree] = await Promise.all([
    run(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    run(['rev-parse', 'HEAD']),
    run(['rev-parse', 'HEAD^{tree}']),
  ]);
  if (branch !== input.branch || head !== input.head || tree !== input.tree) {
    throw new Error('Restored worktree does not match its immutable branch, commit, and tree.');
  }
}

async function persistPreparation(
  transaction: WorktreeMetaTransaction,
  worktreeId: string,
  update: (entry: WorktreeMetaEntry) => WorktreeMetaEntry,
): Promise<WorktreeMetaEntry> {
  const current = (await transaction.readAll())[worktreeId];
  if (!current?.restorePreparation) throw new Error('Exact restore lost its durable preparation.');
  const next = update(current);
  await transaction.save(worktreeId, next);
  return next;
}

async function captureClaimedPath(
  repoPath: string,
  claim: ExactWorkspaceClaimRecord,
): Promise<{ path: string; identity: DestructiveDirectoryIdentity } | null> {
  if (!claim.claimIdentity) return null;
  const claimPresent = !(await pathIsAbsent(claim.claimPath));
  const expectedPresent = !(await pathIsAbsent(claim.expectedPath));
  if (claimPresent && expectedPresent) return null;
  const activePath = claimPresent ? claim.claimPath : expectedPresent ? claim.expectedPath : null;
  if (!activePath) return null;
  const identity = await captureDestructiveDirectoryIdentity(repoPath, activePath);
  const leaf = identity.entries[0];
  if (!leaf || leaf.device !== claim.claimIdentity.device || leaf.inode !== claim.claimIdentity.inode) {
    return null;
  }
  return { path: activePath, identity };
}

async function resumePreparedCleanup(
  input: PreparedRestoreRecoveryInput,
  repoPath: string,
  expectedPath: string,
  transaction: WorktreeMetaTransaction,
  metadata: WorktreeMetaEntry,
  claim: ExactWorkspaceClaimRecord,
): Promise<'absent' | 'unknown'> {
  const preparation = metadata.restorePreparation!;
  if (claim.state === 'prepared' && !claim.claimIdentity && await pathIsAbsent(expectedPath)) {
    const creatorPid = claim.authority?.creatorPid;
    const creatorIdentity = claim.authority?.creatorProcessIdentity;
    if (creatorPid !== undefined || creatorIdentity !== undefined) {
      if (!Number.isInteger(creatorPid) || !isMetadataLockProcessIdentity(creatorIdentity)) {
        return 'unknown';
      }
      const probe = await probeMetadataLockProcessIdentity(Number(creatorPid));
      if (probe.state === 'unknown'
        || (probe.state === 'live' && sameMetadataLockProcessIdentity(probe.identity, creatorIdentity))) {
        return 'unknown';
      }
    }
    if (!(await pathIsAbsent(claim.claimPath))) {
      try {
        await removeExactUnreceiptedEmptyChildDirectory(
          path.dirname(claim.claimPath), claim.parentIdentity, claim.claimPath,
        );
      } catch {
        return 'unknown';
      }
    }
    removeExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId, claim.operationId);
    await transaction.remove(input.worktreeId);
    return 'absent';
  }
  if (preparation.cleanupPhase !== 'purging'
    && preparation.cleanupPhase !== 'target-retired'
    && preparation.cleanupPhase !== 'admin-retired') return 'unknown';
  if (preparation.cleanupPhase === 'purging') {
    const active = await captureClaimedPath(repoPath, claim);
    if (active) return 'unknown';
  }
  if (preparation.cleanupPhase !== 'admin-retired' && preparation.gitAdminIdentity) {
    await cleanupExactGitWorktreeAdmin(repoPath, adminCleanupReceipt(preparation.gitAdminIdentity));
  }
  if (preparation.cleanupPhase !== 'admin-retired') {
    await persistPreparation(transaction, input.worktreeId, (current) => ({
      ...current,
      restorePreparation: { ...current.restorePreparation!, cleanupPhase: 'admin-retired' },
    }));
  }
  await input.afterPreparedStageRetired?.();
  removeExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId, claim.operationId);
  await transaction.remove(input.worktreeId);
  return 'absent';
}

async function clearStalePreparedClaim(
  repoPath: string,
  worktreeId: string,
  expectedPath: string,
): Promise<void> {
  const existing = readExactWorkspaceClaim('restore-creation', repoPath, worktreeId);
  if (!existing) return;
  if (existing.state === 'prepared' && !existing.claimIdentity && await pathIsAbsent(expectedPath)) {
    const creatorPid = existing.authority?.creatorPid;
    const creatorIdentity = existing.authority?.creatorProcessIdentity;
    if (creatorPid !== undefined || creatorIdentity !== undefined) {
      if (!Number.isInteger(creatorPid) || !isMetadataLockProcessIdentity(creatorIdentity)) {
        throw new Error('Exact restore found malformed creator authority.');
      }
      const probe = await probeMetadataLockProcessIdentity(Number(creatorPid));
      if (probe.state === 'unknown'
        || (probe.state === 'live' && sameMetadataLockProcessIdentity(probe.identity, creatorIdentity))) {
        throw new Error('Exact restore creator is still live or cannot be proven dead.');
      }
    }
    if (!(await pathIsAbsent(existing.claimPath))) {
      await removeExactUnreceiptedEmptyChildDirectory(
        path.dirname(existing.claimPath), existing.parentIdentity, existing.claimPath,
      );
    }
    removeExactWorkspaceClaim('restore-creation', repoPath, worktreeId, existing.operationId);
    return;
  }
  throw new Error('Exact restore found a trusted claim without matching manager metadata.');
}

function clearCompletedPublishedClaim(
  repoPath: string,
  worktreeId: string,
  expectedPath: string,
  metadata: WorktreeMetaEntry,
  identity: DestructiveDirectoryIdentity,
): void {
  const claim = readExactWorkspaceClaim('restore-creation', repoPath, worktreeId);
  if (!claim) return;
  const leaf = identity.entries[0];
  if (claim.state !== 'published' || claim.expectedPath !== expectedPath
    || !claim.claimIdentity || !leaf
    || claim.claimIdentity.device !== leaf.device || claim.claimIdentity.inode !== leaf.inode
    || !metadataMatchesIdentity(metadata, identity, identity.canonicalPath)) {
    throw new Error('Exact restore found a stale trusted claim that does not match ready ownership.');
  }
  removeExactWorkspaceClaim('restore-creation', repoPath, worktreeId, claim.operationId);
}

/** Create and register one worktree only after an empty final inode is DB-authorized. */
export async function restoreOwnedWorktreeInTransaction(
  input: ExactRestoreWorktreeInput,
  repoPath: string,
  expectedPath: string,
  transaction: WorktreeMetaTransaction,
): Promise<void> {
  if (input.isolationKind === 'git-worktree') {
    const branch = await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${input.branch}`], {
      windowsHide: true, cwd: repoPath, timeout: 5_000,
    }).then(({ stdout }) => stdout.trim(), () => null);
    if (branch !== input.head) {
      throw new Error('Exact restore refused because the preserved branch is missing or divergent.');
    }
  }

  const parentPath = path.dirname(expectedPath);
  const parentIdentity = await captureWorktreeMaterializationIdentity(parentPath);
  const canonicalTarget = path.join(parentIdentity.canonicalPath, path.basename(expectedPath));
  let metadata = (await transaction.readAll())[input.worktreeId];
  if (metadata?.restorePreparation) {
    if (!metadataMatchesPreparation(metadata, input, expectedPath)) {
      throw new Error('Exact restore found stale preparation metadata.');
    }
    const claim = trustedClaim(metadata, repoPath, expectedPath);
    const active = await captureClaimedPath(repoPath, claim);
    if (active?.path === expectedPath) {
      metadata = await persistPreparation(transaction, input.worktreeId, (current) => ({
        ...current,
        materializationIdentity: materializationIdentity(active.identity),
      }));
      try {
        await verifyGitTruth(expectedPath, input, materializationIdentity(active.identity));
        await input.beforeRestoreOwnershipCommit?.();
        await verifyDestructiveDirectoryIdentity(active.identity);
        await transaction.save(input.worktreeId, {
          ...metadata,
          status: 'ready',
          restorePreparation: undefined,
        });
        await input.afterRestoreReadyCommit?.();
        removeExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId, claim.operationId);
        return;
      } catch {
        const outcome = await discardPreparedRestoreInTransaction(input, repoPath, expectedPath, transaction);
        if (outcome === 'unknown') throw new Error('Exact restore could not retire its partial target.');
        metadata = (await transaction.readAll())[input.worktreeId];
      }
    } else {
      const outcome = await discardPreparedRestoreInTransaction(input, repoPath, expectedPath, transaction);
      if (outcome === 'unknown') {
        throw new Error('Exact restore found ambiguous trusted claim ownership; manual recovery is required.');
      }
      metadata = (await transaction.readAll())[input.worktreeId];
    }
  } else if (!(await pathIsAbsent(expectedPath))) {
    const identity = await captureDestructiveDirectoryIdentity(repoPath, expectedPath);
    if (!metadataMatchesIdentity(metadata, identity, canonicalTarget)) {
      throw new Error('Exact restore refused because the original path is occupied.');
    }
    await verifyGitTruth(expectedPath, input, materializationIdentity(identity));
    clearCompletedPublishedClaim(repoPath, input.worktreeId, expectedPath, metadata!, identity);
    return;
  } else if (!metadata) {
    await clearStalePreparedClaim(repoPath, input.worktreeId, expectedPath);
  }

  if (metadata) throw new Error('Exact restore found stale ownership metadata without its path.');
  const operationId = randomUUID();
  const claimPath = path.join(parentPath, `.o8-restore-claim-${randomUUID()}`);
  prepareExactWorkspaceClaim({
    kind: 'restore-creation',
    repositoryPath: repoPath,
    worktreeId: input.worktreeId,
    operationId,
    expectedPath,
    sourcePath: claimPath,
    claimPath,
    parentIdentity,
    contentDigest: null,
    authority: { head: input.head, tree: input.tree, isolationKind: input.isolationKind },
  });
  const entry: WorktreeMetaEntry = {
    id: input.worktreeId,
    agentType: input.agentType,
    sessionKey: input.sessionKey,
    baseBranch: input.baseBranch,
    createdAt: input.createdAt,
    claudeManaged: false,
    taskName: input.worktreeId,
    branchName: input.branch,
    status: 'creating',
    isolationKind: input.isolationKind,
    materializationParentIdentity: parentIdentity,
    restorePreparation: {
      stagePath: claimPath,
      expectedPath,
      head: input.head,
      tree: input.tree,
      isolationKind: input.isolationKind,
      populationState: 'empty',
      claimOperationId: operationId,
    },
  };
  try {
    await transaction.save(input.worktreeId, entry);
    await input.afterRestoreIntentPrepared?.();
    const childAuthority = exactWorkspaceClaimChildAuthority();
    const created = await createExactChildDirectoryWithReceipt(
      parentPath,
      parentIdentity,
      claimPath,
      { ...childAuthority, repositoryPath: repoPath, worktreeId: input.worktreeId, operationId },
      async (createdIdentity) => {
        await input.beforeRestoreReceiptCommit?.();
        await transaction.save(input.worktreeId, {
          ...entry,
          materializationIdentity: {
            device: createdIdentity.device,
            inode: createdIdentity.inode,
            canonicalPath: path.join(parentIdentity.canonicalPath, path.basename(claimPath)),
          },
        });
      },
      input.beforeRestoreClaimCreate,
      input.beforeRestoreClaimCas,
    );
    await input.afterRestoreStageCreated?.();
    const claimIdentity = await captureDestructiveDirectoryIdentity(repoPath, claimPath);
    const claimLeaf = claimIdentity.entries[0]!;
    const durableClaim = readExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId);
    if (!durableClaim?.claimIdentity
      || durableClaim.operationId !== operationId
      || durableClaim.claimIdentity.device !== created.device
      || durableClaim.claimIdentity.inode !== created.inode
      || claimLeaf.device !== created.device || claimLeaf.inode !== created.inode
      || (await readdir(claimPath)).length !== 0) {
      throw new Error('Exact restore child claim did not match trusted SQLite authority.');
    }
    await input.beforeRestoreStageMove?.(claimPath);
    await verifyDestructiveDirectoryIdentity(claimIdentity);
    await renameExactChildDirectory(
      parentPath,
      parentIdentity,
      claimPath,
      expectedPath,
      { device: claimLeaf.device, inode: claimLeaf.inode },
    );
    const finalIdentity = await captureDestructiveDirectoryIdentity(repoPath, expectedPath);
    if (!identityMatches(claimIdentity, finalIdentity)) {
      throw new Error('Exact restore final target did not retain its trusted empty claim inode.');
    }
    transitionExactWorkspaceClaim({
      kind: 'restore-creation',
      repositoryPath: repoPath,
      worktreeId: input.worktreeId,
      operationId,
      expectedState: 'claimed',
      toState: 'published',
      claimIdentity: { device: claimLeaf.device, inode: claimLeaf.inode },
    });
    await persistPreparation(transaction, input.worktreeId, (current) => ({
      ...current,
      materializationIdentity: materializationIdentity(finalIdentity),
    }));
    await input.afterRestoreStagePrepared?.();
    await persistPreparation(transaction, input.worktreeId, (current) => ({
      ...current,
      restorePreparation: { ...current.restorePreparation!, populationState: 'populating' },
    }));
    const executionIdentity = materializationIdentity(finalIdentity);
    if (input.isolationKind === 'git-worktree') {
      const gitDir = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], {
        windowsHide: true, cwd: repoPath, timeout: 5_000,
      }).then(({ stdout }) => stdout.trim());
      await runOwnedTargetCommands(expectedPath, executionIdentity, [[
        'git', [`--git-dir=${gitDir}`, 'worktree', 'add', '.', input.branch],
      ]], input.afterRestorePopulationCommand);
      const admin = await captureGitWorktreeAdminIdentity(repoPath, expectedPath);
      await persistPreparation(transaction, input.worktreeId, (current) => ({
        ...current,
        restorePreparation: {
          ...current.restorePreparation!, populationState: 'populated', gitAdminIdentity: admin,
        },
      }));
    } else {
      await runOwnedTargetCommands(expectedPath, executionIdentity, [
        ['git', ['init', '-q']],
        ['git', ['remote', 'add', 'origin', repoPath]],
        ['git', ['fetch', '-q', '--no-tags', 'origin', input.head]],
        ['git', ['checkout', '-q', '-B', input.branch, input.head]],
      ], input.afterRestorePopulationCommand);
      await persistPreparation(transaction, input.worktreeId, (current) => ({
        ...current,
        restorePreparation: { ...current.restorePreparation!, populationState: 'populated' },
      }));
    }
    await input.afterRestoreExternalCreate?.();
    const populatedIdentity = await captureDestructiveDirectoryIdentity(repoPath, expectedPath);
    if (!identityMatches(finalIdentity, populatedIdentity)) {
      throw new Error('Exact restore target inode changed during external creation.');
    }
    await verifyGitTruth(expectedPath, input, materializationIdentity(populatedIdentity));
    await input.beforeRestoreStagePublish?.(expectedPath);
    await verifyDestructiveDirectoryIdentity(populatedIdentity);
    await input.beforeRestoreOwnershipCommit?.();
    await verifyDestructiveDirectoryIdentity(populatedIdentity);
    const prior = (await transaction.readAll())[input.worktreeId];
    if (!metadataMatchesIdentity(prior, populatedIdentity, canonicalTarget)) {
      throw new Error('Exact restore ownership changed before materialization committed.');
    }
    await transaction.save(input.worktreeId, {
      ...prior!, status: 'ready', restorePreparation: undefined,
      materializationIdentity: materializationIdentity(populatedIdentity),
    });
    await input.afterRestoreReadyCommit?.();
    removeExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId, operationId);
    await verifyDestructiveDirectoryIdentity(populatedIdentity);
  } catch (error) {
    try {
      const outcome = await discardPreparedRestoreInTransaction(input, repoPath, expectedPath, transaction);
      if (outcome === 'unknown') throw new Error('Exact restore cleanup could not prove trusted ownership.');
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} `
        + `Restore cleanup remains durably claimed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

/** Recover only a target authorized by the trusted SQLite claim. */
export async function discardPreparedRestoreInTransaction(
  input: PreparedRestoreRecoveryInput,
  repoPath: string,
  expectedPath: string,
  transaction: WorktreeMetaTransaction,
): Promise<'absent' | 'removed' | 'unknown'> {
  let metadata = (await transaction.readAll())[input.worktreeId];
  if (!metadata?.restorePreparation || !metadataMatchesPreparation(metadata, input, expectedPath)) {
    return metadata ? 'unknown' : 'absent';
  }
  const claim = trustedClaim(metadata, repoPath, expectedPath);
  const active = await captureClaimedPath(repoPath, claim);
  if (!active) return resumePreparedCleanup(input, repoPath, expectedPath, transaction, metadata, claim);
  const canonicalExpected = active.path === expectedPath
    ? path.join(active.identity.canonicalManagedBase, path.basename(expectedPath))
    : active.identity.canonicalPath;
  metadata = await persistPreparation(transaction, input.worktreeId, (current) => ({
    ...current,
    materializationIdentity: materializationIdentity(active.identity),
  }));
  if (!metadataMatchesIdentity(metadata, active.identity, canonicalExpected)) return 'unknown';

  let admin = metadata.restorePreparation?.gitAdminIdentity;
  const unpopulated = (await readdir(active.path)).length === 0;
  if (input.isolationKind === 'git-worktree' && !unpopulated && !admin) {
    const recovered = await recoverGitWorktreeAdminReceipt(repoPath, active.path);
    admin = recovered.gitAdminPath ? {
      path: recovered.gitAdminPath,
      device: recovered.gitAdminDevice!,
      inode: recovered.gitAdminInode!,
    } : undefined;
  }
  metadata = await persistPreparation(transaction, input.worktreeId, (current) => ({
    ...current,
    restorePreparation: {
      ...current.restorePreparation!, gitAdminIdentity: admin, cleanupPhase: 'purging',
    },
  }));
  if (claim.state !== 'purging') {
    transitionExactWorkspaceClaim({
      kind: 'restore-creation',
      repositoryPath: repoPath,
      worktreeId: input.worktreeId,
      operationId: claim.operationId,
      expectedState: claim.state,
      toState: 'purging',
      claimIdentity: claim.claimIdentity,
    });
  }
  await verifyDestructiveDirectoryIdentity(active.identity);
  const leaf = active.identity.entries[0]!;
  await purgeExactDirectory(active.path, { device: leaf.device, inode: leaf.inode });
  metadata = await persistPreparation(transaction, input.worktreeId, (current) => ({
    ...current,
    restorePreparation: { ...current.restorePreparation!, cleanupPhase: 'target-retired' },
  }));
  await input.afterPreparedTargetRetired?.();
  if (metadata.restorePreparation?.gitAdminIdentity) {
    await cleanupExactGitWorktreeAdmin(
      repoPath,
      adminCleanupReceipt(metadata.restorePreparation.gitAdminIdentity),
    );
  }
  await persistPreparation(transaction, input.worktreeId, (current) => ({
    ...current,
    restorePreparation: { ...current.restorePreparation!, cleanupPhase: 'admin-retired' },
  }));
  await input.afterPreparedStageRetired?.();
  removeExactWorkspaceClaim('restore-creation', repoPath, input.worktreeId, claim.operationId);
  await transaction.remove(input.worktreeId);
  return 'removed';
}
