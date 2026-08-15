import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  DestructiveDirectoryIdentity,
  GitWorktreeAdminIdentity,
} from './worktree-exact-identity';
import { writeExactChildFile } from './exact-parent-operation';
import type { ExactDirectoryManifest, ExactDirectoryManifestEntry } from './exact-directory-purge';
import type {
  ExactWorktreeQuarantineIntent,
  ExactWorktreeQuarantineLocation,
  ExactWorktreeQuarantineLocatorInput,
} from './worktree-exact';
import {
  prepareExactWorkspaceClaim,
  readExactWorkspaceClaim,
} from './exact-workspace-claim-state';

const QUARANTINE_RECEIPT_KIND = 'o8-exact-worktree-quarantine';

export interface ExactWorktreeQuarantineReceipt {
  version: 1;
  kind: typeof QUARANTINE_RECEIPT_KIND;
  identity: string;
  intent: ExactWorktreeQuarantineIntent;
  snapshotFingerprint: string;
  repoPath: string;
  worktreeId: string;
  originalPath: string;
  quarantinePath: string;
  sourceDevice: number;
  sourceInode: number;
  sourceManifestFingerprint: string;
  sourceManifest?: ExactDirectoryManifestEntry[];
  quarantineRootDevice: number;
  quarantineRootInode: number;
  canonicalQuarantineRoot: string;
  gitAdminPath: string | null;
  gitAdminDevice: number | null;
  gitAdminInode: number | null;
  createdAt: string;
}

function expectedQuarantineReceipt(
  input: ExactWorktreeQuarantineLocatorInput,
  location: ExactWorktreeQuarantineLocation,
  createdAt: string,
): ExactWorktreeQuarantineReceipt {
  return {
    version: 1,
    kind: QUARANTINE_RECEIPT_KIND,
    identity: location.identity,
    intent: input.quarantine.intent,
    snapshotFingerprint: input.quarantine.snapshotFingerprint.trim(),
    repoPath: path.resolve(input.repoPath),
    worktreeId: input.worktreeId,
    originalPath: location.originalPath,
    quarantinePath: location.quarantinePath,
    sourceDevice: 0,
    sourceInode: 0,
    sourceManifestFingerprint: '',
    sourceManifest: undefined,
    quarantineRootDevice: 0,
    quarantineRootInode: 0,
    canonicalQuarantineRoot: '',
    gitAdminPath: null,
    gitAdminDevice: null,
    gitAdminInode: null,
    createdAt,
  };
}

function isTrustedQuarantineReceipt(
  value: unknown,
  expected: ExactWorktreeQuarantineReceipt,
): value is ExactWorktreeQuarantineReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ExactWorktreeQuarantineReceipt>;
  return receipt.version === expected.version
    && receipt.kind === expected.kind
    && receipt.identity === expected.identity
    && receipt.intent === expected.intent
    && receipt.snapshotFingerprint === expected.snapshotFingerprint
    && receipt.repoPath === expected.repoPath
    && receipt.worktreeId === expected.worktreeId
    && receipt.originalPath === expected.originalPath
    && receipt.quarantinePath === expected.quarantinePath
    && Number.isSafeInteger(receipt.sourceDevice) && Number(receipt.sourceDevice) >= 0
    && Number.isSafeInteger(receipt.sourceInode) && Number(receipt.sourceInode) > 0
    && typeof receipt.sourceManifestFingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(receipt.sourceManifestFingerprint)
    && (receipt.sourceManifest === undefined
      || (Array.isArray(receipt.sourceManifest)
        && receipt.sourceManifest.length > 0
        && receipt.sourceManifest.every((entry) => (
          typeof entry.relative === 'string'
          && !path.isAbsolute(entry.relative)
          && !entry.relative.split(/[\\/]/).includes('..')
          && Number.isSafeInteger(entry.device)
          && Number.isSafeInteger(entry.inode)
          && ['directory', 'symlink', 'file', 'other'].includes(entry.kind)
          && Number.isSafeInteger(entry.mode)
          && Number.isSafeInteger(entry.linkCount)
        ))))
    && Number.isSafeInteger(receipt.quarantineRootDevice) && Number(receipt.quarantineRootDevice) >= 0
    && Number.isSafeInteger(receipt.quarantineRootInode) && Number(receipt.quarantineRootInode) > 0
    && typeof receipt.canonicalQuarantineRoot === 'string'
    && path.isAbsolute(receipt.canonicalQuarantineRoot)
    && ((receipt.gitAdminPath === null
      && receipt.gitAdminDevice === null
      && receipt.gitAdminInode === null)
      || (typeof receipt.gitAdminPath === 'string'
        && path.isAbsolute(receipt.gitAdminPath)
        && Number.isSafeInteger(receipt.gitAdminDevice)
        && Number(receipt.gitAdminDevice) >= 0
        && Number.isSafeInteger(receipt.gitAdminInode)
        && Number(receipt.gitAdminInode) > 0))
    && typeof receipt.createdAt === 'string'
    && Number.isFinite(Date.parse(receipt.createdAt));
}

export async function readTrustedQuarantineReceipt(
  input: ExactWorktreeQuarantineLocatorInput,
  location: ExactWorktreeQuarantineLocation,
): Promise<{
  exists: boolean;
  receipt: ExactWorktreeQuarantineReceipt | null;
  identity: { device: number; inode: number } | null;
}> {
  let before;
  try {
    before = await lstat(location.receiptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, receipt: null, identity: null };
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    return { exists: true, receipt: null, identity: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(location.receiptPath, 'utf8')) as unknown;
  } catch {
    return { exists: true, receipt: null, identity: null };
  }
  const after = await lstat(location.receiptPath);
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    return { exists: true, receipt: null, identity: null };
  }
  const expected = expectedQuarantineReceipt(input, location, new Date(0).toISOString());
  if (!isTrustedQuarantineReceipt(parsed, expected)) {
    return { exists: true, receipt: null, identity: null };
  }
  const claim = readExactWorkspaceClaim('worktree-quarantine', input.repoPath, input.worktreeId);
  const authority = claim?.authority;
  const trusted = claim && authority && claim.operationId === location.identity
    && claim.expectedPath === location.originalPath
    && claim.sourcePath === location.originalPath
    && claim.claimPath === location.quarantinePath
    && claim.sourceIdentity
    && claim.contentDigest
    ? {
      ...expectedQuarantineReceipt(input, location, new Date(claim.createdAt).toISOString()),
      sourceDevice: claim.sourceIdentity.device,
      sourceInode: claim.sourceIdentity.inode,
      sourceManifestFingerprint: claim.contentDigest,
      sourceManifest: authority.sourceManifest as ExactDirectoryManifestEntry[] | undefined,
      quarantineRootDevice: claim.parentIdentity.device,
      quarantineRootInode: claim.parentIdentity.inode,
      canonicalQuarantineRoot: claim.parentIdentity.canonicalPath,
      gitAdminPath: typeof authority.gitAdminPath === 'string' ? authority.gitAdminPath : null,
      gitAdminDevice: typeof authority.gitAdminDevice === 'number' ? authority.gitAdminDevice : null,
      gitAdminInode: typeof authority.gitAdminInode === 'number' ? authority.gitAdminInode : null,
    } satisfies ExactWorktreeQuarantineReceipt
    : null;
  const mirrorMatchesTrusted = trusted
    && parsed.sourceDevice === trusted.sourceDevice
    && parsed.sourceInode === trusted.sourceInode
    && parsed.sourceManifestFingerprint === trusted.sourceManifestFingerprint
    && JSON.stringify(parsed.sourceManifest) === JSON.stringify(trusted.sourceManifest)
    && parsed.quarantineRootDevice === trusted.quarantineRootDevice
    && parsed.quarantineRootInode === trusted.quarantineRootInode
    && parsed.canonicalQuarantineRoot === trusted.canonicalQuarantineRoot
    && parsed.gitAdminPath === trusted.gitAdminPath
    && parsed.gitAdminDevice === trusted.gitAdminDevice
    && parsed.gitAdminInode === trusted.gitAdminInode;
  return trusted && mirrorMatchesTrusted && isTrustedQuarantineReceipt(trusted, expected)
    ? { exists: true, receipt: trusted, identity: { device: after.dev, inode: after.ino } }
    : { exists: true, receipt: null, identity: null };
}

export async function writeQuarantineReceipt(
  input: ExactWorktreeQuarantineLocatorInput,
  location: ExactWorktreeQuarantineLocation,
  sourceIdentity: DestructiveDirectoryIdentity,
  sourceManifest: ExactDirectoryManifest,
  gitAdminIdentity: GitWorktreeAdminIdentity | null = null,
  beforeWrite?: () => Promise<void>,
): Promise<ExactWorktreeQuarantineReceipt> {
  const rootStat = await lstat(location.quarantineRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Exact quarantine root is not a regular directory.');
  }
  const receipt = {
    ...expectedQuarantineReceipt(input, location, new Date().toISOString()),
    sourceDevice: sourceIdentity.entries[0]!.device,
    sourceInode: sourceIdentity.entries[0]!.inode,
    sourceManifestFingerprint: sourceManifest.fingerprint,
    sourceManifest: sourceManifest.entries,
    quarantineRootDevice: rootStat.dev,
    quarantineRootInode: rootStat.ino,
    canonicalQuarantineRoot: await realpath(location.quarantineRoot),
    gitAdminPath: gitAdminIdentity?.path ?? null,
    gitAdminDevice: gitAdminIdentity?.device ?? null,
    gitAdminInode: gitAdminIdentity?.inode ?? null,
  };
  prepareExactWorkspaceClaim({
    kind: 'worktree-quarantine',
    repositoryPath: input.repoPath,
    worktreeId: input.worktreeId,
    operationId: location.identity,
    expectedPath: location.originalPath,
    sourcePath: location.originalPath,
    claimPath: location.quarantinePath,
    parentIdentity: {
      device: receipt.quarantineRootDevice,
      inode: receipt.quarantineRootInode,
      canonicalPath: receipt.canonicalQuarantineRoot,
    },
    sourceIdentity: { device: receipt.sourceDevice, inode: receipt.sourceInode },
    contentDigest: receipt.sourceManifestFingerprint,
    authority: {
      sourceManifest: receipt.sourceManifest,
      gitAdminPath: receipt.gitAdminPath,
      gitAdminDevice: receipt.gitAdminDevice,
      gitAdminInode: receipt.gitAdminInode,
    },
  });
  await beforeWrite?.();
  await writeExactChildFile(
    location.quarantineRoot,
    {
      device: receipt.quarantineRootDevice,
      inode: receipt.quarantineRootInode,
      canonicalPath: receipt.canonicalQuarantineRoot,
    },
    location.receiptPath,
    `${JSON.stringify(receipt)}\n`,
    0o600,
  );
  return receipt;
}
