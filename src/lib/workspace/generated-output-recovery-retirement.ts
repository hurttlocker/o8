import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { checkWorktreeRemoval, probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureExactDirectoryManifest, purgeExactDirectory, readCapturedPurgeCwdSnapshot,
  type CapturedPurgeProcessWitness, type ExactDirectoryManifest } from './exact-directory-purge';
import { admitExactManagedFinalization, assertExactManagedFinalizationClaim, completeExactManagedFinalization,
  readExactManagedFinalization } from './exact-managed-finalization-state';
import { renameExactChildDirectory } from './exact-parent-operation';
import { prepareExactWorkspaceClaim, readExactWorkspaceClaim, removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim, type ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';
import { verifyGeneratedOutputBank } from './generated-output-bank';
import { readGeneratedOutputRecoveryEntries, verifyGeneratedOutputRecovery } from './generated-output-recovery';
import type { GeneratedOutputRetirementHooks } from './generated-output-retirement';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import { readGeneratedOutputResource, saveGeneratedOutputResource, withGeneratedOutputBankExclusion,
  type GeneratedOutputResource } from './generated-output-state';

const kind = 'generated-output-recovery-retirement' as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function identityAt(candidate: string) {
  const stat = await lstat(candidate).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Verification recovery namespace was replaced.');
  return { device: stat.dev, inode: stat.ino };
}

function eligibility(resource: GeneratedOutputResource): void {
  const copy = resource.recovery;
  if (resource.state !== 'retired' || !resource.retirement || !resource.bank || !resource.owner
    || !copy?.root || copy.purpose !== 'verification-disposable' || !['complete', 'retired'].includes(copy.state)
    || copy.bankDigest !== resource.bank.digest
    || readExactManagedFinalization(resource.retirement.claim)?.state !== 'complete') {
    throw new Error('Only a registered successful disposable verification copy after durable source retirement is eligible.');
  }
}

function claimBinding(resource: GeneratedOutputResource, claim: ExactWorkspaceClaimRecord): void {
  const copy = resource.recovery!;
  if (!uuid.test(claim.operationId) || claim.kind !== kind || claim.repositoryPath !== resource.owner!.repositoryPath
    || claim.worktreeId !== copy.operationId || claim.expectedPath !== copy.path || claim.sourcePath !== copy.path
    || claim.claimPath !== path.join(copy.parent.canonicalPath, `.o8-retired-verification-${claim.operationId}`)
    || claim.parentIdentity.canonicalPath !== copy.parent.canonicalPath
    || claim.parentIdentity.device !== copy.parent.device || claim.parentIdentity.inode !== copy.parent.inode
    || claim.sourceIdentity?.device !== copy.root!.device || claim.sourceIdentity.inode !== copy.root!.inode
    || (claim.claimIdentity && (claim.claimIdentity.device !== copy.root!.device || claim.claimIdentity.inode !== copy.root!.inode))
    || claim.contentDigest !== resource.bank!.digest || claim.authority?.resourceId !== resource.resourceId
    || claim.authority.recoveryOperationId !== copy.operationId || claim.authority.bankDigest !== resource.bank!.digest
    || claim.authority.sourceRetirementOperationId !== resource.retirement!.operationId
    || claim.authority.resourceVersion !== resource.version) {
    throw new Error('Verification recovery claim lost its immutable generation binding.');
  }
}

async function authority(resource: GeneratedOutputResource, candidatePath: string | null,
  claim?: ExactWorkspaceClaimRecord, captured?: CapturedPurgeProcessWitness): Promise<void> {
  eligibility(resource);
  const copy = resource.recovery!;
  if (copy.state !== 'complete') throw new Error('Verification recovery is no longer complete.');
  const current = readGeneratedOutputResource(resource.resourceId);
  if (!current || current.version !== resource.version) throw new Error('Verification recovery resource changed.');
  if (claim) {
    claimBinding(resource, claim);
    const currentClaim = readExactWorkspaceClaim(kind, claim.repositoryPath, claim.worktreeId);
    if (JSON.stringify(currentClaim) !== JSON.stringify(claim)) {
      throw new Error('Verification recovery lost its current exact claim.');
    }
    if (claim.state === 'purging') assertExactManagedFinalizationClaim(claim);
  }
  await assertWorktreeMaterializationIdentity(copy.parent.canonicalPath, copy.parent);
  assertWorkspaceRetentionReleased(copy.path, copy.root!);
  if (claim) assertWorkspaceRetentionReleased(claim.claimPath, copy.root!);
  await verifyGeneratedOutputBank(resource.bank!);
  if (candidatePath) {
    await verifyGeneratedOutputRecovery(resource, candidatePath, claim?.state === 'purging'
      ? claim.authority?.releaseIntents as Array<{ relative: string; device: number; inode: number }> : undefined);
    const probe = captured
      ? (await probeLiveProcessInside(candidatePath, { snapshot: await readCapturedPurgeCwdSnapshot(captured, candidatePath) })).status === 'clear'
      : (await checkWorktreeRemoval(candidatePath, { logPrefix: 'verification-recovery-retirement' })).allowed;
    if (!probe) throw new Error('Verification recovery has a live or unknown consumer.');
  }
  assertWorkspaceRetentionReleased(copy.path, copy.root!);
  if (claim) assertWorkspaceRetentionReleased(claim.claimPath, copy.root!);
}

/** Retire only the explicitly disposable, verified generation through its exact claim. */
export async function retireGeneratedOutputVerification(resourceId: string,
  hooks: GeneratedOutputRetirementHooks = {}): Promise<GeneratedOutputResource> {
  return retireVerification(resourceId, hooks);
}

async function retireVerification(resourceId: string, hooks: GeneratedOutputRetirementHooks): Promise<GeneratedOutputResource> {
  const selected = readGeneratedOutputResource(resourceId);
  if (!selected) throw new Error('Generated-output resource was not found.');
  eligibility(selected);
  return withGeneratedOutputBankExclusion(selected, async () => {
    const resource = readGeneratedOutputResource(resourceId)!;
    eligibility(resource);
    const copy = resource.recovery!;
    const cwd = path.resolve(process.cwd());
    if (cwd === copy.path || cwd.startsWith(copy.path + path.sep)) throw new Error('Verification maintenance must run outside the recovery copy.');
    let claim = readExactWorkspaceClaim(kind, resource.owner!.repositoryPath, copy.operationId);
    if (copy.state === 'retired') {
      if (claim || !copy.retirement || readExactManagedFinalization(copy.retirement.claim)?.state !== 'complete'
        || await identityAt(copy.path) || await identityAt(copy.retirement.claim.claimPath)) {
        throw new Error('Retired verification recovery has inconsistent finalization or returned namespaces.');
      }
      await verifyGeneratedOutputBank(resource.bank!);
      return resource;
    }
    if (!claim) {
      await authority(resource, copy.path);
      const operationId = randomUUID();
      claim = prepareExactWorkspaceClaim({ kind, repositoryPath: resource.owner!.repositoryPath,
        worktreeId: copy.operationId, operationId, expectedPath: copy.path, sourcePath: copy.path,
        claimPath: path.join(copy.parent.canonicalPath, `.o8-retired-verification-${operationId}`),
        parentIdentity: copy.parent, sourceIdentity: copy.root!, contentDigest: resource.bank!.digest,
        authority: { resourceId, recoveryOperationId: copy.operationId, bankDigest: resource.bank!.digest,
          sourceRetirementOperationId: resource.retirement!.operationId, resourceVersion: resource.version } });
    }
    claimBinding(resource, claim);
    const source = await identityAt(copy.path); const moved = await identityAt(claim.claimPath);
    const same = (value: { device: number; inode: number } | null) => !value
      || (value.device === copy.root!.device && value.inode === copy.root!.inode);
    if ((source && moved) || !same(source) || !same(moved)) throw new Error('Verification recovery source or claim was replaced.');
    if (claim.state === 'prepared') {
      if (!source && !moved) throw new Error('Prepared verification recovery disappeared without authority.');
      if (source) {
        await authority(resource, copy.path, claim);
        await renameExactChildDirectory(copy.parent.canonicalPath, copy.parent, copy.path, claim.claimPath, copy.root!);
        await hooks.afterRename?.();
      }
      claim = transitionExactWorkspaceClaim({ kind, repositoryPath: claim.repositoryPath, worktreeId: copy.operationId,
        operationId: claim.operationId, expectedState: 'prepared', toState: 'claimed', claimIdentity: copy.root! });
    }
    if (claim.state === 'claimed') {
      await authority(resource, claim.claimPath, claim);
      const manifest = await captureExactDirectoryManifest(claim.claimPath, copy.root!);
      const releaseIntents = readGeneratedOutputRecoveryEntries(resource).filter(entry => entry.kind === 'file')
        .map(entry => ({ relative: entry.relative, device: entry.device, inode: entry.inode,
          originalBytes: entry.bytes, originalSha256: entry.sha256, releaseBytes: 0 }));
      claim = transitionExactWorkspaceClaim({ kind, repositoryPath: claim.repositoryPath, worktreeId: copy.operationId,
        operationId: claim.operationId, expectedState: 'claimed', toState: 'purging',
        authority: { ...claim.authority, purgeManifest: manifest, releaseIntents } });
    }
    if (claim.state !== 'purging' || await identityAt(copy.path)) throw new Error('Verification recovery purge state or source changed.');
    if (await identityAt(claim.claimPath)) {
      await hooks.beforePurge?.();
      await authority(resource, claim.claimPath, claim);
      const manifest = claim.authority?.purgeManifest as ExactDirectoryManifest;
      if (!manifest?.entries.length) throw new Error('Verification recovery purge has no exact persisted manifest.');
      await purgeExactDirectory(claim.claimPath, copy.root!, undefined,
        async (candidatePath, witness) => {
          if (!witness) throw new Error('Verification purge has no native captured process witness.');
          await authority(resource, candidatePath, claim!, witness);
        }, async candidatePath => {
          await authority(resource, candidatePath, claim!);
          if (await identityAt(copy.path) || (await readdir(candidatePath)).length) throw new Error('Verification finalization is not exact, empty and source absent.');
          admitExactManagedFinalization(claim!);
          await hooks.afterFinalAdmission?.();
        }, manifest.fingerprint, manifest.entries);
      await hooks.afterFinalRemoval?.();
      await authority(resource, null, claim);
      if (await identityAt(copy.path) || await identityAt(claim.claimPath)) throw new Error('Verification finalization namespace returned.');
      completeExactManagedFinalization(claim, 'removed');
    } else {
      const finalization = readExactManagedFinalization(claim);
      if (!finalization) throw new Error('Missing verification claim has no durable final-empty admission.');
      await authority(resource, null, claim);
      if (await identityAt(copy.path) || await identityAt(claim.claimPath)) throw new Error('Verification replay namespace returned.');
      if (finalization.state === 'admitted') completeExactManagedFinalization(claim, 'absent-after-admission');
    }
    await authority(resource, null, claim);
    if (readExactManagedFinalization(claim)?.state !== 'complete'
      || await identityAt(copy.path) || await identityAt(claim.claimPath)) throw new Error('Verification completion has no retained exact finalization.');
    return getSqlite().transaction(() => {
      assertExactManagedFinalizationClaim(claim!);
      assertWorkspaceRetentionReleased(copy.path, copy.root!);
      assertWorkspaceRetentionReleased(claim!.claimPath, copy.root!);
      const next = saveGeneratedOutputResource(resource, { recovery: { ...copy, state: 'retired',
        retirement: { operationId: claim!.operationId, retiredAt: Date.now(), claim: claim! } } });
      removeExactWorkspaceClaim(kind, claim!.repositoryPath, copy.operationId, claim!.operationId);
      return next;
    }).immediate();
  });
}
