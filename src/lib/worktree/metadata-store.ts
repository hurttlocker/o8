import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { readJsonFile } from '@/lib/fs/json';
import {
  acquireMetadataTransactionLease,
  readMetadataTransactionState,
  releaseMetadataTransactionLease,
  writeMetadataTransactionState,
  type MetadataTransactionBoundary,
  type MetadataTransactionLease,
} from '@/lib/worktree/metadata-transaction-lease';
import {
  assertManagedWorktreeMaterializationBoundary,
  observeManagedWorktreeRootIdentity,
  resolveWorktreeRootLayout,
} from '@/lib/worktree/root-layout';
import type { WorktreeMetaEntry, WorktreeMetaStore } from '@/lib/worktree/types';
import { isMetadataLockProcessIdentity } from './metadata-lock-process-identity';
import { observeStorageVolume, type StorageRootIdentity } from '@/lib/workspace/storage-admission';
import {
  readPinnedWorkspaceFile,
  readPinnedWorkspaceFileReceipt,
  writePinnedWorkspaceFile,
} from './materialization-leaf-io';
import type { WorktreeMaterializationIdentity } from './materialization-identity';

const META_FILENAME = '.meta.json';

const mutationQueues = new Map<string, Promise<void>>();
export interface WorktreeMetadataBoundary {
  root: StorageRootIdentity;
  base: WorktreeMaterializationIdentity;
}
const boundaryContext = new AsyncLocalStorage<ReadonlyMap<string, WorktreeMetadataBoundary>>();

async function captureMetadataBoundary(repoPath: string): Promise<WorktreeMetadataBoundary> {
  const root = await observeManagedWorktreeRootIdentity(repoPath);
  const observation = await observeStorageVolume(root.canonicalPath);
  if (observation.status !== 'observed') {
    throw new Error('The worktree metadata volume could not be observed.');
  }
  const base = await assertManagedWorktreeMaterializationBoundary(
    repoPath, observation.volumeId!, root,
  );
  return {
    root,
    base: {
      canonicalPath: base.canonicalPath,
      device: Number(base.device),
      inode: Number(base.inode),
    },
  };
}

export function withWorktreeMetadataBoundary<T>(
  repoPath: string,
  boundary: WorktreeMetadataBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  const next = new Map(boundaryContext.getStore() ?? []);
  next.set(path.resolve(repoPath), boundary);
  return boundaryContext.run(next, operation);
}

function isWorktreeMetaEntry(value: unknown, id: string): value is WorktreeMetaEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<WorktreeMetaEntry>;
  return entry.id === id
    && typeof entry.agentType === 'string'
    && entry.agentType.trim().length > 0
    && (entry.sessionKey === undefined || typeof entry.sessionKey === 'string')
    && typeof entry.baseBranch === 'string'
    && Number.isFinite(entry.createdAt)
    && typeof entry.claudeManaged === 'boolean'
    && typeof entry.taskName === 'string'
    && (entry.branchName === undefined || typeof entry.branchName === 'string')
    && (entry.status === undefined || [
      'creating', 'setup', 'ready', 'active', 'stale', 'merging', 'cleaning',
    ].includes(entry.status))
    && (entry.isolationKind === undefined
      || entry.isolationKind === 'git-worktree'
      || entry.isolationKind === 'apfs-cow-clone')
    && (entry.hydrationPaths === undefined
      || (Array.isArray(entry.hydrationPaths)
        && entry.hydrationPaths.every((item) => typeof item === 'string')))
    && (entry.dependencyRecipeKey === undefined
      || (typeof entry.dependencyRecipeKey === 'string'
        && /^[0-9a-f]{64}$/.test(entry.dependencyRecipeKey)))
    && (entry.creationOwner === undefined
      || (typeof entry.creationOwner === 'object'
        && entry.creationOwner !== null
        && Number.isInteger(entry.creationOwner.pid)
        && entry.creationOwner.pid > 0
        && isMetadataLockProcessIdentity(entry.creationOwner.identity)))
    && (entry.creationBranchHead === undefined
      || (typeof entry.creationBranchHead === 'string'
        && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.creationBranchHead)))
    && (entry.materializationIdentity === undefined
      || (typeof entry.materializationIdentity === 'object'
        && entry.materializationIdentity !== null
        && Number.isFinite(entry.materializationIdentity.device)
        && Number.isFinite(entry.materializationIdentity.inode)
        && typeof entry.materializationIdentity.canonicalPath === 'string'
        && entry.materializationIdentity.canonicalPath.length > 0))
    && (entry.materializationParentIdentity === undefined
      || (typeof entry.materializationParentIdentity === 'object'
        && entry.materializationParentIdentity !== null
        && Number.isFinite(entry.materializationParentIdentity.device)
        && Number.isFinite(entry.materializationParentIdentity.inode)
        && typeof entry.materializationParentIdentity.canonicalPath === 'string'
        && entry.materializationParentIdentity.canonicalPath.length > 0))
    && (entry.restorePreparation === undefined
      || (typeof entry.restorePreparation === 'object'
        && entry.restorePreparation !== null
        && typeof entry.restorePreparation.stagePath === 'string'
        && typeof entry.restorePreparation.expectedPath === 'string'
        && typeof entry.restorePreparation.head === 'string'
        && typeof entry.restorePreparation.tree === 'string'
        && (entry.restorePreparation.isolationKind === 'git-worktree'
          || entry.restorePreparation.isolationKind === 'apfs-cow-clone')));
}

function validatedMetaStore(value: unknown, metaPath: string): WorktreeMetaStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Worktree metadata at ${metaPath} is not an object.`);
  }
  const store = value as Partial<WorktreeMetaStore>;
  if (store.version !== 1
    || !store.worktrees
    || typeof store.worktrees !== 'object'
    || Array.isArray(store.worktrees)
    || !Object.entries(store.worktrees).every(([id, entry]) => isWorktreeMetaEntry(entry, id))) {
    throw new Error(`Worktree metadata at ${metaPath} has an unsupported shape.`);
  }
  return store as WorktreeMetaStore;
}

async function readMeta(
  metaPath: string,
  pinned?: { basePath: string; identity: WorktreeMaterializationIdentity },
): Promise<Record<string, WorktreeMetaEntry>> {
  if (pinned && path.resolve(path.dirname(metaPath)) === path.resolve(pinned.basePath)) {
    const raw = await readPinnedWorkspaceFile(pinned.basePath, pinned.identity, META_FILENAME);
    if (raw === null) return {};
    return validatedMetaStore(JSON.parse(raw) as unknown, metaPath).worktrees;
  }
  let metaStat: Awaited<ReturnType<typeof lstat>>;
  try {
    metaStat = await lstat(metaPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  if (!metaStat.isFile() || metaStat.isSymbolicLink()) {
    throw new Error(`Worktree metadata at ${metaPath} is not a regular file.`);
  }
  return validatedMetaStore(await readJsonFile<unknown>(metaPath), metaPath).worktrees;
}

async function withMutationLock<T>(
  repoPath: string,
  boundary: WorktreeMetadataBoundary | undefined,
  operation: (lease: MetadataTransactionLease) => Promise<T>,
): Promise<T> {
  const layout = resolveWorktreeRootLayout(repoPath);
  const metadataRoot = layout.primaryBase;
  const queueKey = path.resolve(metadataRoot);
  const previous = mutationQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queued = previous.then(() => current);
  mutationQueues.set(queueKey, queued);
  await previous;
  let holder: MetadataTransactionLease | null = null;
  try {
    const leaseBoundary: MetadataTransactionBoundary | undefined = boundary ? {
      rootPath: layout.configuredRoot,
      rootCanonicalPath: boundary.root.canonicalPath,
      rootDevice: Number(boundary.root.device),
      rootInode: Number(boundary.root.inode),
      metadataRootIdentity: boundary.base,
    } : undefined;
    holder = await acquireMetadataTransactionLease(metadataRoot, leaseBoundary);
    return await operation(holder);
  } finally {
    try {
      if (holder) releaseMetadataTransactionLease(holder);
    } finally {
      releaseQueue();
      if (mutationQueues.get(queueKey) === queued) mutationQueues.delete(queueKey);
    }
  }
}

export interface WorktreeMetaTransaction {
  readAll: () => Promise<Record<string, WorktreeMetaEntry>>;
  remove: (worktreeId: string) => Promise<void>;
  save: (worktreeId: string, entry: WorktreeMetaEntry) => Promise<void>;
}

export async function withWorktreeMetaTransaction<T>(
  repoPath: string,
  operation: (transaction: WorktreeMetaTransaction) => Promise<T>,
): Promise<T> {
  const boundary = boundaryContext.getStore()?.get(path.resolve(repoPath))
    ?? await captureMetadataBoundary(repoPath);
  return withMutationLock(repoPath, boundary, async (lease) => {
    const metaPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, META_FILENAME);
    const durableState = readMetadataTransactionState(lease);
    let entries: Record<string, WorktreeMetaEntry>;
    let mirrorIdentity: { device: number; inode: number } | null;
    if (durableState === null) {
      const imported = await readPinnedWorkspaceFileReceipt(
        path.dirname(metaPath), boundary.base, META_FILENAME,
      );
      entries = imported
        ? validatedMetaStore(JSON.parse(imported.content) as unknown, metaPath).worktrees
        : {};
      mirrorIdentity = imported
        ? { device: imported.device, inode: imported.inode }
        : null;
      writeMetadataTransactionState(
        lease,
        JSON.stringify({ version: 1, worktrees: entries } satisfies WorktreeMetaStore),
        mirrorIdentity,
      );
    } else {
      entries = validatedMetaStore(JSON.parse(durableState.payload) as unknown, metaPath).worktrees;
      mirrorIdentity = durableState.mirrorIdentity;
    }
    const persist = async (): Promise<void> => {
      const serialized = JSON.stringify({ version: 1, worktrees: entries } satisfies WorktreeMetaStore, null, 2);
      writeMetadataTransactionState(lease, serialized, mirrorIdentity);
      mirrorIdentity = await writePinnedWorkspaceFile(
        path.dirname(metaPath),
        boundary.base,
        META_FILENAME,
        serialized,
        undefined,
        mirrorIdentity,
      );
      writeMetadataTransactionState(lease, serialized, mirrorIdentity);
      const persisted = await readMeta(metaPath, {
        basePath: path.dirname(metaPath), identity: boundary.base,
      });
      if (JSON.stringify(persisted) !== JSON.stringify(entries)) {
        throw new Error(`Exact worktree metadata verification failed at ${metaPath}.`);
      }
    };
    return operation({
      readAll: async () => entries,
      remove: async (worktreeId) => {
        if (!(worktreeId in entries)) return;
        delete entries[worktreeId];
        await persist();
      },
      save: async (worktreeId, entry) => {
        entries[worktreeId] = entry;
        await persist();
      },
    });
  });
}
