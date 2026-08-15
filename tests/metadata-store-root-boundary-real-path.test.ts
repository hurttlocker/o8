import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  beforeWrite: null as ((workspacePath: string, relativePath: string) => void) | null,
  afterPinnedStep: null as ((workspacePath: string, relativePath: string, step: string) => void) | null,
}));

vi.mock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
  return {
    ...actual,
    writePinnedWorkspaceFile: async (
      ...args: Parameters<typeof actual.writePinnedWorkspaceFile>
    ) => {
      h.beforeWrite?.(args[0], args[2]);
      const originalStep = args[4];
      const step = originalStep || h.afterPinnedStep
        ? async (segment: string) => {
            await originalStep?.(segment);
            h.afterPinnedStep?.(args[0], args[2], segment);
          }
        : undefined;
      return actual.writePinnedWorkspaceFile(
        args[0], args[1], args[2], args[3], step, args[5],
      );
    },
  };
});

const {
  withWorktreeMetadataBoundary,
  withWorktreeMetaTransaction,
} = await import('@/lib/worktree/metadata-store');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const {
  assertManagedWorktreeMaterializationBoundary,
  observeManagedWorktreeRootIdentity,
  resolveWorktreeRootLayout,
} = await import('@/lib/worktree/root-layout');
const { observeStorageVolume } = await import('@/lib/workspace/storage-admission');

const priorRoot = process.env.O8_WORKTREE_ROOT;

async function boundary(repoRoot: string) {
  const root = await observeManagedWorktreeRootIdentity(repoRoot);
  const volume = await observeStorageVolume(resolveWorktreeRootLayout(repoRoot).configuredRoot);
  expect(volume.status).toBe('observed');
  const base = await assertManagedWorktreeMaterializationBoundary(repoRoot, volume.volumeId!, root);
  return {
    root,
    base: await captureWorktreeMaterializationIdentity(base.canonicalPath),
  };
}

function entry(id: string) {
  return {
    id,
    agentType: 'codex' as const,
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: id,
    status: 'creating' as const,
    isolationKind: 'git-worktree' as const,
  };
}

function replaceRoot(repoRoot: string, replacement: string): void {
  const configuredRoot = resolveWorktreeRootLayout(repoRoot).configuredRoot;
  renameSync(configuredRoot, `${configuredRoot}-admitted`);
  symlinkSync(replacement, configuredRoot, 'dir');
}

afterEach(() => {
  h.beforeWrite = null;
  h.afterPinnedStep = null;
  if (priorRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorRoot;
});

it('rejects a configured-root swap before the metadata lease', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-boundary-repo-'));
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-boundary-root-'));
  const expected = await boundary(repoRoot);
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-boundary-replacement-'));
  const sentinel = path.join(replacement, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  replaceRoot(repoRoot, replacement);

  await expect(withWorktreeMetadataBoundary(repoRoot, expected, () => (
    withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save('before-lease', entry('before-lease')))
  ))).rejects.toThrow(/root changed|metadata root changed/);

  expect(existsSync(path.join(replacement, '.meta.json'))).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
});

it('pins the metadata write when the configured root changes after lease acquisition', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-write-repo-'));
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-write-root-'));
  const expected = await boundary(repoRoot);
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-write-replacement-'));
  const sentinel = path.join(replacement, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  h.beforeWrite = (_workspacePath, relativePath) => {
    if (relativePath !== '.meta.json') return;
    h.beforeWrite = null;
    replaceRoot(repoRoot, replacement);
  };

  await expect(withWorktreeMetadataBoundary(repoRoot, expected, () => (
    withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save('after-lease', entry('after-lease')))
  ))).rejects.toThrow(/ownership changed|ENOENT|no such file/i);

  expect(existsSync(path.join(replacement, '.meta.json'))).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
});

it('pins a real manager metadata caller without an inherited boundary', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-manager-repo-'));
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-manager-root-'));
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-manager-replacement-'));
  const sentinel = path.join(replacement, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  await withWorktreeMetaTransaction(
    repoRoot,
    (transaction) => transaction.save('manager-caller', entry('manager-caller')),
  );
  h.beforeWrite = (_workspacePath, relativePath) => {
    if (relativePath !== '.meta.json') return;
    h.beforeWrite = null;
    replaceRoot(repoRoot, replacement);
  };

  await expect(new WorktreeManager(repoRoot).linkSession('manager-caller', 'session'))
    .rejects.toThrow(/ownership changed|ENOENT|no such file/i);

  expect(existsSync(path.join(replacement, '.meta.json'))).toBe(false);
  expect(existsSync(sentinel)).toBe(true);
});

it('keeps durable metadata authority when the mirror target is replaced after open', async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-target-repo-'));
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-meta-target-root-'));
  await withWorktreeMetaTransaction(
    repoRoot,
    (transaction) => transaction.save('owned', entry('owned')),
  );
  const metaPath = path.join(resolveWorktreeRootLayout(repoRoot).primaryBase, '.meta.json');
  const admitted = `${metaPath}-admitted`;
  h.afterPinnedStep = (_workspacePath, relativePath, step) => {
    if (relativePath !== '.meta.json' || step !== 'atomic-opened') return;
    h.afterPinnedStep = null;
    renameSync(metaPath, admitted);
    writeFileSync(metaPath, 'external-sentinel');
  };

  await expect(withWorktreeMetaTransaction(
    repoRoot,
    (transaction) => transaction.save('durable-after-refusal', entry('durable-after-refusal')),
  )).rejects.toThrow(/target changed before direct write/);

  expect(readFileSync(metaPath, 'utf8')).toBe('external-sentinel');
  expect(readFileSync(admitted, 'utf8')).not.toContain('durable-after-refusal');
  await expect(withWorktreeMetaTransaction(
    repoRoot,
    (transaction) => transaction.readAll(),
  )).resolves.toHaveProperty('durable-after-refusal');
}, 30_000);
