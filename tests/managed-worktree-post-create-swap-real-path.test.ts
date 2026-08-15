import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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
  beforeBinding: null as ((workspacePath: string, relativePath: string) => void) | null,
  afterWrite: null as ((workspacePath: string, relativePath: string) => void) | null,
}));

vi.mock('@/lib/worktree/materialization-leaf-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/materialization-leaf-io')>();
  return {
    ...actual,
    createPinnedWorkspaceBinding: async (
      ...args: Parameters<typeof actual.createPinnedWorkspaceBinding>
    ) => {
      h.beforeBinding?.(args[0], args[2]);
      return actual.createPinnedWorkspaceBinding(...args);
    },
    writePinnedWorkspaceFile: async (
      ...args: Parameters<typeof actual.writePinnedWorkspaceFile>
    ) => {
      await actual.writePinnedWorkspaceFile(...args);
      h.afterWrite?.(args[0], args[2]);
    },
  };
});

const { getSqlite } = await import('@/lib/db');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
const {
  observeManagedWorktreeRootIdentity,
  resolveManagedWorktreeStorageTarget,
} = await import('@/lib/worktree/root-layout');
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

const priorRoot = process.env.O8_WORKTREE_ROOT;
const priorTypecheck = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-swap-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'base',
  ], { cwd: repo });
  return repo;
}

async function reserve(repoRoot: string, packetId: string): Promise<string> {
  const reservationId = `packet-storage:${packetId}:1`;
  const result = await new StorageAdmissionStore(getSqlite()).reserve({
    mutationId: `packet-storage-reserve:${packetId}:1`,
    reservationId,
    targetPath: resolveManagedWorktreeStorageTarget(repoRoot),
    rootIdentity: await observeManagedWorktreeRootIdentity(repoRoot),
    exactBytes: 1,
    ownerId: packetId,
    ownerGeneration: 1,
    leaseExpiresAt: Date.now() + 60_000,
    policy: { reserveRatio: 0, absoluteFloorBytes: 0 },
  });
  expect(result.decision).toBe('reserved');
  return reservationId;
}

function swapWorkspace(workspacePath: string, replacement: string): void {
  renameSync(workspacePath, `${workspacePath}-admitted`);
  symlinkSync(replacement, workspacePath, 'dir');
}

afterEach(() => {
  h.beforeBinding = null;
  h.afterWrite = null;
  if (priorRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorRoot;
  if (priorTypecheck === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = priorTypecheck;
});

it('does not copy an environment secret after the created workspace is replaced', async () => {
  const repoRoot = makeRepo();
  writeFileSync(path.join(repoRoot, '.env'), 'PRIVATE_VALUE=do-not-copy\n');
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-root-'));
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-env-replacement-'));
  const sentinel = path.join(replacement, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  const packetId = `env-swap-${Date.now()}`;
  const reservationId = await reserve(repoRoot, packetId);
  h.beforeBinding = (workspacePath, relativePath) => {
    if (relativePath !== '.env') return;
    h.beforeBinding = null;
    swapWorkspace(workspacePath, replacement);
  };

  await expect(prepareLaunchWorktree({
    repoRoot, agentType: 'codex', taskName: 'env swap proof',
    branchName: `inline/${packetId}`, baseBranch: 'main', isolate: true,
    skipSetup: true, packetId, storageAdmissionReservationId: reservationId,
  })).rejects.toThrow(/ownership changed|identity changed/);

  expect(existsSync(path.join(replacement, '.env'))).toBe(false);
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
}, 30_000);

it('preserves dirty replacement files when reset and rollback see a changed workspace', async () => {
  const repoRoot = makeRepo();
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-reset-root-'));
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-reset-replacement-'));
  writeFileSync(path.join(replacement, 'README.md'), 'dirty replacement\n');
  const packetId = `reset-swap-${Date.now()}`;
  const reservationId = await reserve(repoRoot, packetId);
  h.afterWrite = (workspacePath, relativePath) => {
    if (relativePath !== '.claude/settings.json') return;
    h.afterWrite = null;
    swapWorkspace(workspacePath, replacement);
  };

  await expect(prepareLaunchWorktree({
    repoRoot, agentType: 'codex', taskName: 'reset swap proof',
    branchName: `inline/${packetId}`, baseBranch: 'main', isolate: true,
    skipSetup: true, packetId, storageAdmissionReservationId: reservationId,
  })).rejects.toThrow(/ownership changed|identity changed/);

  expect(readFileSync(path.join(replacement, 'README.md'), 'utf8')).toBe('dirty replacement\n');
}, 30_000);

it('does not hydrate cache bytes after an APFS clone is replaced', async () => {
  const repoRoot = makeRepo();
  mkdirSync(path.join(repoRoot, '.next', 'cache'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.next', 'cache', 'private-cache'), 'do-not-copy');
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-cow-root-'));
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const replacement = mkdtempSync(path.join(os.tmpdir(), 'o8-post-create-cow-replacement-'));
  const sentinel = path.join(replacement, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  const packetId = `cow-swap-${Date.now()}`;
  const reservationId = await reserve(repoRoot, packetId);
  h.beforeBinding = (workspacePath, relativePath) => {
    if (relativePath !== '.next/cache') return;
    h.beforeBinding = null;
    swapWorkspace(workspacePath, replacement);
  };

  await expect(prepareLaunchWorktree({
    repoRoot, agentType: 'codex', taskName: 'cache swap proof',
    branchName: `inline/${packetId}`, baseBranch: 'main', isolate: true,
    isolationPreference: 'apfs-cow-clone', skipSetup: true, packetId,
    storageAdmissionReservationId: reservationId,
  })).rejects.toThrow(/ownership changed|identity changed/);

  expect(existsSync(path.join(replacement, '.next', 'cache'))).toBe(false);
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
}, 30_000);
