import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceIsolationKind } from '@/lib/worktree/types';
import type { ProcessQuiescenceReceipt } from './process-quiescence';
import { type WorktreeMetaTransaction, withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import {
  captureDestructiveDirectoryIdentity,
  captureGitWorktreeAdminIdentity,
  cleanupExactGitWorktreeAdmin,
  verifyGitWorktreeAdminIdentity,
  verifyDestructiveDirectoryIdentity,
} from './worktree-exact-identity';
import {
  claimExactWorktreeQuarantine,
  ExactWorktreeQuarantineError,
  heldQuarantinePath,
  markClaimedQuarantinePurging,
  restoreClaimedQuarantine,
} from './worktree-exact-quarantine';
import { captureExactDirectoryManifest, purgeExactDirectory } from './exact-directory-purge';
import { retireExactFile } from './exact-file-retirement';
import {
  readExactWorkspaceClaim,
  removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim,
} from './exact-workspace-claim-state';
import { renameExactChildDirectory } from './exact-parent-operation';
import {
  readTrustedQuarantineReceipt,
  writeQuarantineReceipt,
  type ExactWorktreeQuarantineReceipt,
} from './worktree-exact-receipt';
import { exactManagedPath, exactQuarantineLocation } from './worktree-exact-location';
import {
  exactPathExists as pathExists,
  exactPathKind as pathKind,
  settleMissingQuarantineMirrorAuthority,
  verifyFreshProcessQuiescence,
} from './worktree-exact-helpers';
import {
  discardPreparedRestoreInTransaction,
  restoreOwnedWorktreeInTransaction,
} from './worktree-exact-restore';

export { ExactWorktreeQuarantineError } from './worktree-exact-quarantine';
export type { ExactWorktreeQuarantineReceipt } from './worktree-exact-receipt';

const execFileAsync = promisify(execFile);

export type ExactWorktreeQuarantineIntent = 'park' | 'restore-rollback';
export interface ExactWorktreeQuarantineKey {
  snapshotFingerprint: string;
  intent: ExactWorktreeQuarantineIntent;
}
export interface ExactWorktreeQuarantineLocation {
  identity: string;
  originalPath: string;
  quarantineRoot: string;
  quarantinePath: string;
  receiptPath: string;
  claimPrefix: string;
  purgePrefix: string;
}
export type ExactWorktreeQuarantineState = 'clear' | 'prepared' | 'quarantined' | 'purging'
  | 'completed' | 'conflict' | 'untrusted';
export interface ExactWorktreeQuarantineInspection {
  state: ExactWorktreeQuarantineState;
  location: ExactWorktreeQuarantineLocation;
  receipt: ExactWorktreeQuarantineReceipt | null;
  originalExists: boolean;
  quarantineExists: boolean;
  receiptExists: boolean;
  receiptIdentity?: { device: number; inode: number } | null;
  claimedPath?: string | null;
  purgingPath?: string | null;
  note: string;
}
export interface ExactWorktreeQuarantineLocatorInput {
  repoPath: string;
  worktreeId: string;
  expectedPath: string;
  quarantine: ExactWorktreeQuarantineKey;
}
export interface ExactParkWorktreeInput {
  repoPath: string;
  worktreeId: string;
  expectedPath: string;
  expectedBranch: string;
  expectedHead: string;
  expectedSessionKey: string;
  probeProcessQuiescence: (sessionKey: string, workspacePath: string) => Promise<ProcessQuiescenceReceipt>;
  quarantine: ExactWorktreeQuarantineKey;
  verifyQuarantinedClone?: (quarantinePath: string) => Promise<void>;
  /** Deterministic race seam used to prove the atomic rename boundary. */
  beforeQuarantineRename?: () => Promise<void>;
  /** Deterministic crash seam after the original path is no longer targeted. */
  afterQuarantineRename?: () => Promise<void>;
  /** Deterministic race seam immediately before the receipted path is claimed for deletion. */
  beforeQuarantineClaim?: () => Promise<void>;
  /** Deterministic race seam after parent capture but before receipt publication. */
  beforeQuarantineReceiptWrite?: () => Promise<void>;
  /** Deterministic race seams around the mutable Git marker capture. */
  afterGitAdminMarkerLstat?: () => Promise<void>;
  afterGitAdminMarkerRead?: () => Promise<void>;
  /** Deterministic race seam after claim proof but before the purge-state rename. */
  beforeQuarantinePurgeRename?: () => Promise<void>;
  /** Deterministic race seam before exact quarantine rollback into the original name. */
  beforeQuarantineRestoreRename?: () => Promise<void>;
  /** Deterministic race seam after claim identity proof but before cwd capture. */
  beforeClaimedPurge?: (claimedPath: string) => Promise<void>;
  /** Deterministic race seam after the descendant identity manifest is captured. */
  afterClaimedTreeCapture?: (claimedPath: string) => Promise<void>;
  /** Deterministic crash seam after exact content release but before tree retirement. */
  afterClaimedContentRelease?: (claimedPath: string) => Promise<void>;
  /** Deterministic crash seam after the receipt mirror retires but before trusted authority clears. */
  afterQuarantineReceiptRetired?: () => Promise<void>;
}
export interface ResolveExactWorktreeQuarantineInput extends ExactWorktreeQuarantineLocatorInput {
  disposition: 'restore' | 'remove';
  expectedSessionKey: string;
  probeProcessQuiescence: ExactParkWorktreeInput['probeProcessQuiescence'];
  verifyQuarantinedClone: (quarantinePath: string) => Promise<void>;
  afterQuarantineReceiptRetired?: () => Promise<void>;
}

export interface ExactRestoreWorktreeInput {
  repoPath: string;
  worktreeId: string;
  expectedPath: string;
  branch: string;
  head: string;
  tree: string;
  baseBranch: string;
  agentType: string;
  sessionKey?: string;
  createdAt: number;
  isolationKind: WorkspaceIsolationKind;
  /** Deterministic crash seam after durable intent and before final-target creation. */
  afterRestoreIntentPrepared?: () => Promise<void>;
  /** Parent-crash seam after creator identity binds and before the child creates its claim. */
  beforeRestoreClaimCreate?: () => Promise<void>;
  /** Parent-crash seam after empty claim creation and before the child's trusted SQLite CAS. */
  beforeRestoreClaimCas?: () => Promise<void>;
  /** Parent-crash seam after the child fsyncs its receipt but before DB mirroring. */
  beforeRestoreReceiptCommit?: () => Promise<void>;
  /** Deterministic crash seam after the exact final-target inode is durably receipted. */
  afterRestoreStagePrepared?: () => Promise<void>;
  /** Deterministic race seam after final-target creation and its exact inode receipt commit. */
  afterRestoreStageCreated?: () => Promise<void>;
  /** Deterministic crash seam after external Git creation and before final verification. */
  afterRestoreExternalCreate?: () => Promise<void>;
  /** Deterministic crash seam after one final-target population command commits. */
  afterRestorePopulationCommand?: (completedCommands: number) => Promise<void>;
  /** Legacy race seam retained for tests; no stage-to-target move is performed. */
  beforeRestoreStageMove?: (stagePath: string) => Promise<void>;
  /** Legacy publication seam; the final target already owns the populated inode. */
  beforeRestoreStagePublish?: (stagePath: string) => Promise<void>;
  beforeRestoreOwnershipCommit?: () => Promise<void>;
  /** Crash seam after ready metadata commits and before trusted claim retirement. */
  afterRestoreReadyCommit?: () => Promise<void>;
}

export type PreparedRestoreRecoveryInput = Pick<
  ExactRestoreWorktreeInput,
  'repoPath' | 'worktreeId' | 'expectedPath' | 'branch' | 'head' | 'tree' | 'isolationKind'
> & {
  /** Deterministic crash seam after target purge and before Git-admin cleanup. */
  afterPreparedTargetRetired?: () => Promise<void>;
  /** Deterministic crash seam after exact target/admin retirement and before metadata retirement. */
  afterPreparedStageRetired?: () => Promise<void>;
};

export function locateExactWorktreeQuarantine(
  input: ExactWorktreeQuarantineLocatorInput,
): ExactWorktreeQuarantineLocation {
  return exactQuarantineLocation(input);
}


export async function inspectExactWorktreeQuarantine(
  input: ExactWorktreeQuarantineLocatorInput,
): Promise<ExactWorktreeQuarantineInspection> {
  const location = exactQuarantineLocation(input);
  const rootKind = await pathKind(location.quarantineRoot);
  const originalKind = await pathKind(location.originalPath);
  if (rootKind !== 'absent' && rootKind !== 'directory') {
    return {
      state: 'untrusted', location, receipt: null,
      originalExists: originalKind !== 'absent', quarantineExists: false, receiptExists: false,
      note: 'The exact quarantine root is not a regular directory.',
    };
  }
  const quarantineKind = rootKind === 'directory' ? await pathKind(location.quarantinePath) : 'absent';
  const claimedNames = rootKind === 'directory'
    ? (await readdir(location.quarantineRoot)).filter((name) => name.startsWith(location.claimPrefix))
    : [];
  const purgingNames = rootKind === 'directory'
    ? (await readdir(location.quarantineRoot)).filter((name) => name.startsWith(location.purgePrefix))
    : [];
  if (claimedNames.length + purgingNames.length > 1) {
    return {
      state: 'untrusted', location, receipt: null,
      originalExists: originalKind !== 'absent', quarantineExists: true, receiptExists: false,
      claimedPath: null,
      purgingPath: null,
      note: 'Multiple exact quarantine claims exist.',
    };
  }
  const claimedPath = claimedNames[0] ? path.join(location.quarantineRoot, claimedNames[0]) : null;
  const purgingPath = purgingNames[0] ? path.join(location.quarantineRoot, purgingNames[0]) : null;
  const claimedKind = claimedPath ? await pathKind(claimedPath) : 'absent';
  const purgingKind = purgingPath ? await pathKind(purgingPath) : 'absent';
  const { exists: receiptExists, receipt, identity: receiptIdentity } = rootKind === 'directory'
    ? await readTrustedQuarantineReceipt(input, location)
    : { exists: false, receipt: null, identity: null };
  const originalExists = originalKind !== 'absent';
  const quarantineExists = quarantineKind !== 'absent'
    || claimedKind !== 'absent'
    || purgingKind !== 'absent';
  const heldQuarantinePath = quarantineKind !== 'absent'
    ? location.quarantinePath
    : claimedPath ?? purgingPath;
  const rootStat = receipt ? await lstat(location.quarantineRoot).catch(() => null) : null;
  const heldPath = quarantineExists ? heldQuarantinePath : originalExists ? location.originalPath : null;
  const heldStat = receipt && heldPath ? await lstat(heldPath).catch(() => null) : null;
  const authority = readExactWorkspaceClaim(
    'worktree-quarantine', path.resolve(input.repoPath), input.worktreeId,
  );
  const missingMirrorSettlement = !receiptExists
    ? settleMissingQuarantineMirrorAuthority(input, location, authority, quarantineExists)
    : null;
  if (missingMirrorSettlement) {
    return {
      state: 'clear', location, receipt: null,
      originalExists, quarantineExists: false, receiptExists: false,
      claimedPath,
      purgingPath,
      note: missingMirrorSettlement,
    };
  }
  const receiptIdentityTrusted = !receipt || Boolean(
    rootStat?.isDirectory()
    && !rootStat.isSymbolicLink()
    && rootStat.dev === receipt.quarantineRootDevice
    && rootStat.ino === receipt.quarantineRootInode
    && await realpath(location.quarantineRoot).catch(() => '') === receipt.canonicalQuarantineRoot
    && (!heldPath || (
      heldStat?.isDirectory()
      && !heldStat.isSymbolicLink()
      && heldStat.dev === receipt.sourceDevice
      && heldStat.ino === receipt.sourceInode
    )),
  );
  if ((originalExists && originalKind !== 'directory')
    || (quarantineKind !== 'absent' && claimedKind !== 'absent')
    || (quarantineKind !== 'absent' && quarantineKind !== 'directory')
    || (claimedKind !== 'absent' && claimedKind !== 'directory')
    || (purgingKind !== 'absent' && purgingKind !== 'directory')
    || (receiptExists && !receipt)
    || !receiptIdentityTrusted) {
    return {
      state: 'untrusted', location, receipt,
      originalExists, quarantineExists, receiptExists,
      claimedPath,
      purgingPath,
      note: !receipt && receiptExists
        ? 'The exact quarantine ownership receipt is not trusted.'
        : !receiptIdentityTrusted
          ? 'The exact quarantine directory identity is not trusted.'
          : 'The exact quarantine paths are not trusted.',
    };
  }
  if (originalExists && quarantineExists) {
    return {
      state: 'conflict', location, receipt,
      originalExists, quarantineExists, receiptExists,
      claimedPath,
      purgingPath,
      note: 'Both the original and exact quarantine paths exist.',
    };
  }
  if (!receipt) {
    return {
      state: quarantineExists ? 'untrusted' : 'clear', location, receipt,
      originalExists, quarantineExists, receiptExists,
      claimedPath,
      purgingPath,
      note: quarantineExists
        ? 'The exact quarantine path has no matching ownership receipt.'
        : 'No exact quarantine receipt or workspace is present.',
    };
  }
  if (originalExists) {
    return {
      state: 'prepared', location, receipt,
      originalExists, quarantineExists, receiptExists,
      receiptIdentity,
      claimedPath,
      purgingPath,
      note: 'The ownership receipt was persisted before the rename began.',
    };
  }
  if (purgingKind !== 'absent') {
    if (authority?.state === 'claimed' && receipt) {
      transitionExactWorkspaceClaim({
        kind: 'worktree-quarantine',
        repositoryPath: input.repoPath,
        worktreeId: input.worktreeId,
        operationId: authority.operationId,
        expectedState: 'claimed',
        toState: 'purging',
        claimIdentity: { device: receipt.sourceDevice, inode: receipt.sourceInode },
      });
    }
    return {
      state: 'purging', location, receipt,
      originalExists, quarantineExists, receiptExists,
      receiptIdentity,
      claimedPath,
      purgingPath,
      note: 'The exact managed workspace crossed the durable content-release boundary.',
    };
  }
  if (quarantineExists) {
    if (authority?.state === 'prepared' && receipt) {
      transitionExactWorkspaceClaim({
        kind: 'worktree-quarantine',
        repositoryPath: input.repoPath,
        worktreeId: input.worktreeId,
        operationId: authority.operationId,
        expectedState: 'prepared',
        toState: 'claimed',
        claimIdentity: { device: receipt.sourceDevice, inode: receipt.sourceInode },
      });
    }
    return {
      state: 'quarantined', location, receipt,
      originalExists, quarantineExists, receiptExists,
      receiptIdentity,
      claimedPath,
      purgingPath,
      note: 'The exact managed workspace is held in quarantine.',
    };
  }
  return {
    state: 'completed', location, receipt,
    originalExists, quarantineExists, receiptExists,
    receiptIdentity,
    claimedPath,
    purgingPath,
    note: 'The exact quarantine workspace is absent and its receipt remains.',
  };
}

async function retireQuarantineReceipt(
  inspection: ExactWorktreeQuarantineInspection,
  afterReceiptRetired?: () => Promise<void>,
): Promise<void> {
  if (!inspection.receiptIdentity) {
    throw new Error('Exact quarantine receipt identity is unavailable for retirement.');
  }
  if (!inspection.receipt) throw new Error('Exact quarantine receipt authority is unavailable.');
  const authority = readExactWorkspaceClaim(
    'worktree-quarantine', inspection.receipt.repoPath, inspection.receipt.worktreeId,
  );
  if (!authority || authority.operationId !== inspection.location.identity) {
    throw new Error('Exact quarantine trusted authority is unavailable for retirement.');
  }
  if (authority.state !== 'published') {
    transitionExactWorkspaceClaim({
      kind: 'worktree-quarantine',
      repositoryPath: inspection.receipt.repoPath,
      worktreeId: inspection.receipt.worktreeId,
      operationId: inspection.location.identity,
      expectedState: authority.state,
      toState: 'published',
    });
  }
  await retireExactFile(inspection.location.receiptPath, inspection.receiptIdentity);
  await afterReceiptRetired?.();
  removeExactWorkspaceClaim(
    'worktree-quarantine',
    inspection.receipt.repoPath,
    inspection.receipt.worktreeId,
    inspection.location.identity,
  );
}

export async function resolveExactWorktreeQuarantine(
  input: ResolveExactWorktreeQuarantineInput,
): Promise<'clear' | 'receipt-cleared' | 'restored' | 'removed'> {
  const inspection = await inspectExactWorktreeQuarantine(input);
  if (inspection.state === 'clear') return 'clear';
  if (inspection.state === 'untrusted' || inspection.state === 'conflict') {
    throw new Error(`Exact quarantine recovery refused: ${inspection.note}`);
  }
  if (inspection.state === 'prepared') {
    await retireQuarantineReceipt(inspection, input.afterQuarantineReceiptRetired);
    return 'receipt-cleared';
  }
  if (inspection.state === 'completed') {
    if (inspection.receipt) {
      await cleanupExactGitWorktreeAdmin(path.resolve(input.repoPath), inspection.receipt);
    }
    await withWorktreeMetaTransaction(path.resolve(input.repoPath), (transaction) => (
      transaction.remove(input.worktreeId)
    ));
    await retireQuarantineReceipt(inspection, input.afterQuarantineReceiptRetired);
    return 'receipt-cleared';
  }
  if (!inspection.receipt) {
    throw new Error('Exact quarantine recovery refused because its receipt is absent.');
  }
  const receipt = inspection.receipt;
  const heldPath = heldQuarantinePath(inspection);
  if (inspection.state === 'purging') {
    await verifyFreshProcessQuiescence(
      input.expectedSessionKey,
      heldPath,
      input.probeProcessQuiescence,
    );
    await purgeExactDirectory(heldPath, {
      device: receipt.sourceDevice,
      inode: receipt.sourceInode,
    }, undefined, undefined, undefined, receipt.sourceManifestFingerprint, receipt.sourceManifest);
    await cleanupExactGitWorktreeAdmin(path.resolve(input.repoPath), receipt);
    await withWorktreeMetaTransaction(path.resolve(input.repoPath), (transaction) => (
      transaction.remove(input.worktreeId)
    ));
    await retireQuarantineReceipt(inspection, input.afterQuarantineReceiptRetired);
    return 'removed';
  }
  await input.verifyQuarantinedClone(heldPath);
  await verifyFreshProcessQuiescence(
    input.expectedSessionKey,
    heldPath,
    input.probeProcessQuiescence,
  );
  const claimedPath = await claimExactWorktreeQuarantine(inspection);
  if (input.disposition === 'restore') {
    await restoreClaimedQuarantine(inspection, claimedPath);
    await retireQuarantineReceipt(inspection, input.afterQuarantineReceiptRetired);
    return 'restored';
  }
  const purgingPath = await markClaimedQuarantinePurging(inspection, claimedPath);
  await purgeExactDirectory(purgingPath, {
    device: receipt.sourceDevice,
    inode: receipt.sourceInode,
  }, undefined, undefined, undefined, receipt.sourceManifestFingerprint, receipt.sourceManifest);
  await cleanupExactGitWorktreeAdmin(path.resolve(input.repoPath), receipt);
  await withWorktreeMetaTransaction(path.resolve(input.repoPath), (transaction) => (
    transaction.remove(input.worktreeId)
  ));
  await retireQuarantineReceipt(inspection, input.afterQuarantineReceiptRetired);
  return 'removed';
}

async function parkExactWorktreeInTransaction(
  input: ExactParkWorktreeInput,
  repoPath: string,
  expectedPath: string,
  transaction: WorktreeMetaTransaction,
): Promise<WorkspaceIsolationKind> {
  const metadata = (await transaction.readAll())[input.worktreeId];
  if (!metadata || metadata.claudeManaged) {
    throw new Error('Exact parking requires a registered o8-managed workspace.');
  }
  if (!(await pathExists(expectedPath))) {
    throw new Error('Exact parking refused because the managed worktree path is absent.');
  }
  const isolationKind = metadata.isolationKind ?? 'git-worktree';
  const destructiveIdentity = await captureDestructiveDirectoryIdentity(repoPath, expectedPath);
  const materializationIdentity = metadata.materializationIdentity;
  const materializedLeaf = destructiveIdentity.entries[0];
  if (!materializationIdentity || !materializedLeaf
    || materializedLeaf.device !== materializationIdentity.device
    || materializedLeaf.inode !== materializationIdentity.inode
    || destructiveIdentity.canonicalPath !== materializationIdentity.canonicalPath) {
    throw new Error('Exact parking refused because managed workspace ownership is absent or changed.');
  }
  const verificationPath = destructiveIdentity.canonicalPath;
  const [{ stdout: branch }, { stdout: head }] = await Promise.all([
    execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      windowsHide: true, cwd: verificationPath, timeout: 5_000,
    }),
    execFileAsync('git', ['rev-parse', 'HEAD'], {
      windowsHide: true, cwd: verificationPath, timeout: 5_000,
    }),
  ]);
  if (branch.trim() !== input.expectedBranch || head.trim() !== input.expectedHead) {
    throw new Error('Exact parking refused because the worktree branch or HEAD changed.');
  }
  if (isolationKind === 'git-worktree') {
    const gitAdminIdentity = await captureGitWorktreeAdminIdentity(repoPath, verificationPath, {
      afterMarkerLstat: input.afterGitAdminMarkerLstat,
      afterMarkerRead: input.afterGitAdminMarkerRead,
    });
    await verifyFreshProcessQuiescence(
      input.expectedSessionKey,
      expectedPath,
      input.probeProcessQuiescence,
    );
    await verifyDestructiveDirectoryIdentity(destructiveIdentity);
    const [{ stdout: finalBranch }, { stdout: finalHead }, { stdout: finalStatus }] = await Promise.all([
      execFileAsync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        windowsHide: true, cwd: destructiveIdentity.canonicalPath, timeout: 5_000,
      }),
      execFileAsync('git', ['rev-parse', 'HEAD'], {
        windowsHide: true, cwd: destructiveIdentity.canonicalPath, timeout: 5_000,
      }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        windowsHide: true, cwd: destructiveIdentity.canonicalPath, timeout: 10_000,
      }),
    ]);
    await verifyDestructiveDirectoryIdentity(destructiveIdentity);
    if (finalBranch.trim() !== input.expectedBranch || finalHead.trim() !== input.expectedHead) {
      throw new Error('Exact parking refused because final canonical Git truth changed.');
    }
    if (finalStatus.trim()) {
      throw new Error('Exact parking refused because final Git status contains tracked or untracked writes.');
    }
    await verifyGitWorktreeAdminIdentity(repoPath, verificationPath, gitAdminIdentity);
    const locatorInput: ExactWorktreeQuarantineLocatorInput = {
      repoPath,
      worktreeId: input.worktreeId,
      expectedPath,
      quarantine: input.quarantine,
    };
    const location = exactQuarantineLocation(locatorInput);
    const initial = await inspectExactWorktreeQuarantine(locatorInput);
    if (initial.state !== 'clear' || !initial.originalExists) {
      throw new Error(`Git worktree parking refused: ${initial.note}`);
    }
    const sourceManifest = await captureExactDirectoryManifest(
      expectedPath,
      {
        device: destructiveIdentity.entries[0]!.device,
        inode: destructiveIdentity.entries[0]!.inode,
      },
    );
    const quarantineReceipt = await writeQuarantineReceipt(
      locatorInput,
      location,
      destructiveIdentity,
      sourceManifest,
      gitAdminIdentity,
      input.beforeQuarantineReceiptWrite,
    );
    await verifyDestructiveDirectoryIdentity(destructiveIdentity);
    await input.beforeQuarantineRename?.();
    await renameExactChildDirectory(
      location.quarantineRoot,
      {
        device: quarantineReceipt.quarantineRootDevice,
        inode: quarantineReceipt.quarantineRootInode,
        canonicalPath: quarantineReceipt.canonicalQuarantineRoot,
      },
      expectedPath,
      location.quarantinePath,
      { device: quarantineReceipt.sourceDevice, inode: quarantineReceipt.sourceInode },
    );
    await input.afterQuarantineRename?.();
    const quarantined = await inspectExactWorktreeQuarantine(locatorInput);
    if (quarantined.state !== 'quarantined') {
      if (!quarantined.originalExists && await pathKind(location.quarantinePath) !== 'absent') {
        await renameExactChildDirectory(
          location.quarantineRoot,
          {
            device: quarantineReceipt.quarantineRootDevice,
            inode: quarantineReceipt.quarantineRootInode,
            canonicalPath: quarantineReceipt.canonicalQuarantineRoot,
          },
          location.quarantinePath,
          expectedPath,
          { device: quarantineReceipt.sourceDevice, inode: quarantineReceipt.sourceInode },
        ).catch(() => {});
      }
      throw new Error(`Git worktree quarantine identity verification refused removal: ${quarantined.note}`);
    }
    await verifyFreshProcessQuiescence(
      input.expectedSessionKey,
      location.quarantinePath,
      input.probeProcessQuiescence,
    );
    try {
      if (!input.verifyQuarantinedClone) {
        throw new Error('Git worktree parking requires post-rename content verification.');
      }
      await input.verifyQuarantinedClone(location.quarantinePath);
      const beforeRemove = await inspectExactWorktreeQuarantine(locatorInput);
      const claimedPath = await claimExactWorktreeQuarantine(
        beforeRemove,
        input.beforeQuarantineClaim,
      );
      const purgingPath = await markClaimedQuarantinePurging(
        beforeRemove,
        claimedPath,
        input.beforeQuarantinePurgeRename,
      );
      await purgeExactDirectory(purgingPath, {
        device: quarantineReceipt.sourceDevice,
        inode: quarantineReceipt.sourceInode,
      }, input.beforeClaimedPurge, input.afterClaimedTreeCapture, input.afterClaimedContentRelease,
      quarantineReceipt.sourceManifestFingerprint, quarantineReceipt.sourceManifest);
      await cleanupExactGitWorktreeAdmin(repoPath, quarantineReceipt);
      await transaction.remove(input.worktreeId);
      await retireQuarantineReceipt(beforeRemove, input.afterQuarantineReceiptRetired);
    } catch (error) {
      try {
        const heldAfterFailure = await inspectExactWorktreeQuarantine(locatorInput);
        if (heldAfterFailure.state === 'quarantined'
          && await pathKind(expectedPath) === 'absent') {
          const claimedPath = await claimExactWorktreeQuarantine(heldAfterFailure);
          await restoreClaimedQuarantine(
            heldAfterFailure,
            claimedPath,
            input.beforeQuarantineRestoreRename,
          );
          await retireQuarantineReceipt(heldAfterFailure, input.afterQuarantineReceiptRetired);
        }
      } catch (restoreError) {
        throw new ExactWorktreeQuarantineError(
          `Git quarantine removal failed and exact restore was incomplete: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          'restore',
          location,
        );
      }
      throw error;
    }
  } else {
    if (!input.verifyQuarantinedClone) {
      throw new Error('APFS copy-on-write parking requires a post-rename quarantine verifier.');
    }
    const locatorInput: ExactWorktreeQuarantineLocatorInput = {
      repoPath,
      worktreeId: input.worktreeId,
      expectedPath,
      quarantine: input.quarantine,
    };
    const location = exactQuarantineLocation(locatorInput);
    const initial = await inspectExactWorktreeQuarantine(locatorInput);
    if (initial.state !== 'clear' || !initial.originalExists) {
      throw new Error(`APFS copy-on-write parking refused: ${initial.note}`);
    }
    if (await pathKind(location.quarantineRoot) !== 'directory') {
      throw new Error('APFS copy-on-write parking quarantine root is not a regular directory.');
    }
    const sourceManifest = await captureExactDirectoryManifest(
      expectedPath,
      {
        device: destructiveIdentity.entries[0]!.device,
        inode: destructiveIdentity.entries[0]!.inode,
      },
    );
    const quarantineReceipt = await writeQuarantineReceipt(
      locatorInput,
      location,
      destructiveIdentity,
      sourceManifest,
      null,
      input.beforeQuarantineReceiptWrite,
    );
    try {
      await verifyFreshProcessQuiescence(
        input.expectedSessionKey,
        expectedPath,
        input.probeProcessQuiescence,
      );
    } catch (error) {
      throw error;
    }
    try {
      await input.beforeQuarantineRename?.();
      await renameExactChildDirectory(
        location.quarantineRoot,
        {
          device: quarantineReceipt.quarantineRootDevice,
          inode: quarantineReceipt.quarantineRootInode,
          canonicalPath: quarantineReceipt.canonicalQuarantineRoot,
        },
        expectedPath,
        location.quarantinePath,
        { device: quarantineReceipt.sourceDevice, inode: quarantineReceipt.sourceInode },
      );
    } catch (error) {
      throw error;
    }
    await input.afterQuarantineRename?.();
    const quarantined = await inspectExactWorktreeQuarantine(locatorInput);
    if (quarantined.state !== 'quarantined') {
      if (!quarantined.originalExists && await pathKind(location.quarantinePath) !== 'absent') {
        const receipt = quarantined.receipt;
        if (receipt) {
          await renameExactChildDirectory(
            location.quarantineRoot,
            {
              device: receipt.quarantineRootDevice,
              inode: receipt.quarantineRootInode,
              canonicalPath: receipt.canonicalQuarantineRoot,
            },
            location.quarantinePath,
            expectedPath,
            { device: receipt.sourceDevice, inode: receipt.sourceInode },
          ).catch(() => {});
        }
      }
      throw new Error(`Copy-on-write quarantine identity verification refused removal: ${quarantined.note}`);
    }
    try {
      await input.verifyQuarantinedClone(location.quarantinePath);
    } catch (error) {
      try {
        await restoreClaimedQuarantine(
          quarantined,
          location.quarantinePath,
          input.beforeQuarantineRestoreRename,
        );
        await retireQuarantineReceipt(quarantined, input.afterQuarantineReceiptRetired);
      } catch (restoreError) {
        throw new ExactWorktreeQuarantineError(
          `Copy-on-write quarantine verification failed and exact restore was incomplete: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          'restore',
          location,
        );
      }
      throw error;
    }
    let beforeRemove: ExactWorktreeQuarantineInspection;
    try {
      beforeRemove = await inspectExactWorktreeQuarantine(locatorInput);
      const claimedPath = await claimExactWorktreeQuarantine(
        beforeRemove,
        input.beforeQuarantineClaim,
      );
      const purgingPath = await markClaimedQuarantinePurging(
        beforeRemove,
        claimedPath,
        input.beforeQuarantinePurgeRename,
      );
      await purgeExactDirectory(purgingPath, {
        device: beforeRemove.receipt!.sourceDevice,
        inode: beforeRemove.receipt!.sourceInode,
      }, input.beforeClaimedPurge, input.afterClaimedTreeCapture, input.afterClaimedContentRelease,
      beforeRemove.receipt!.sourceManifestFingerprint, beforeRemove.receipt!.sourceManifest);
      await transaction.remove(input.worktreeId);
    } catch (error) {
      throw new ExactWorktreeQuarantineError(
        `Copy-on-write quarantine removal was incomplete: ${error instanceof Error ? error.message : String(error)}`,
        'remove',
        location,
      );
    }
    try {
      await retireQuarantineReceipt(beforeRemove, input.afterQuarantineReceiptRetired);
    } catch (error) {
      throw new ExactWorktreeQuarantineError(
        `Copy-on-write quarantine receipt cleanup was incomplete: ${error instanceof Error ? error.message : String(error)}`,
        'receipt-cleanup',
        location,
      );
    }
  }
  if (await pathExists(expectedPath)) {
    throw new Error('Git reported worktree removal success but the exact path still exists.');
  }
  await transaction.remove(input.worktreeId);
  return isolationKind;
}

/** Remove one already-verified clean Git worktree while preserving its branch. */
export function parkExactWorktree(input: ExactParkWorktreeInput): Promise<WorkspaceIsolationKind> {
  const repoPath = path.resolve(input.repoPath);
  const expectedPath = exactManagedPath(repoPath, input.worktreeId, input.expectedPath);
  return withWorktreeMetaTransaction(repoPath, (transaction) => (
    parkExactWorktreeInTransaction(input, repoPath, expectedPath, transaction)
  ));
}

/** Recreate one parked worktree at its original path and restore manager metadata. */
export function restoreExactWorktree(input: ExactRestoreWorktreeInput): Promise<void> {
  const repoPath = path.resolve(input.repoPath);
  const expectedPath = exactManagedPath(repoPath, input.worktreeId, input.expectedPath);
  return withWorktreeMetaTransaction(repoPath, (transaction) => (
    restoreOwnedWorktreeInTransaction(input, repoPath, expectedPath, transaction)
  ));
}

/** Remove only a durably receipted restore target after an interrupted restore. */
export function discardPreparedExactRestore(
  input: PreparedRestoreRecoveryInput,
): Promise<'absent' | 'removed' | 'unknown'> {
  const repoPath = path.resolve(input.repoPath);
  const expectedPath = exactManagedPath(repoPath, input.worktreeId, input.expectedPath);
  return withWorktreeMetaTransaction(repoPath, (transaction) => (
    discardPreparedRestoreInTransaction(input, repoPath, expectedPath, transaction)
  ));
}
