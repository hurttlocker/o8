import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

const h = vi.hoisted(() => ({
  beforePinnedExecution: null as ((workspacePath: string) => void) | null,
  delayedBasePath: null as string | null,
  activeBaseExecutions: 0,
  maxBaseExecutions: 0,
}));

vi.mock('@/lib/worktree/materialization-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/materialization-execution')>();
  return {
    ...actual,
    withWorktreeMaterializationExecution: async <T>(
      workspacePath: string,
      identity: WorktreeMaterializationIdentity,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (workspacePath === h.delayedBasePath) {
        h.activeBaseExecutions += 1;
        h.maxBaseExecutions = Math.max(h.maxBaseExecutions, h.activeBaseExecutions);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      const interleave = h.beforePinnedExecution;
      h.beforePinnedExecution = null;
      interleave?.(workspacePath);
      try {
        return await actual.withWorktreeMaterializationExecution(workspacePath, identity, operation);
      } finally {
        if (workspacePath === h.delayedBasePath) h.activeBaseExecutions -= 1;
      }
    },
  };
});

const { getSqlite } = await import('@/lib/db');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
const {
  observeManagedWorktreeRootIdentity,
  resolveManagedWorktreeStorageTarget,
  resolveWorktreeRootLayout,
} = await import('@/lib/worktree/root-layout');
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

const priorRoot = process.env.O8_WORKTREE_ROOT;
const priorTypecheck = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-descendant-repo-'));
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

afterEach(() => {
  h.beforePinnedExecution = null;
  h.delayedBasePath = null;
  h.activeBaseExecutions = 0;
  h.maxBaseExecutions = 0;
  if (priorRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorRoot;
  if (priorTypecheck === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = priorTypecheck;
});

it('serializes real and symlink-alias launches targeting the same managed base', async () => {
  const repoRoot = makeRepo();
  const aliasRoot = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-alias`);
  symlinkSync(repoRoot, aliasRoot, 'dir');
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-alias-root-'));
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const firstPacket = `alias-first-${Date.now()}`;
  const secondPacket = `alias-second-${Date.now()}`;
  const [firstReservation, secondReservation] = await Promise.all([
    reserve(repoRoot, firstPacket),
    reserve(aliasRoot, secondPacket),
  ]);
  h.delayedBasePath = resolveWorktreeRootLayout(repoRoot).primaryBase;

  await Promise.all([
    prepareLaunchWorktree({
      repoRoot, agentType: 'codex', taskName: 'alias first',
      branchName: `inline/${firstPacket}`, baseBranch: 'main', isolate: true,
      skipSetup: true, packetId: firstPacket,
      storageAdmissionReservationId: firstReservation,
    }),
    prepareLaunchWorktree({
      repoRoot: aliasRoot, agentType: 'codex', taskName: 'alias second',
      branchName: `inline/${secondPacket}`, baseBranch: 'main', isolate: true,
      skipSetup: true, packetId: secondPacket,
      storageAdmissionReservationId: secondReservation,
    }),
  ]);

  expect(h.maxBaseExecutions).toBe(1);
}, 30_000);

it('pins Git creation when a validated descendant is swapped before execution', async () => {
  const repoRoot = makeRepo();
  process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-descendant-root-'));
  const packetId = `descendant-swap-${Date.now()}`;
  const reservationId = `packet-storage:${packetId}:1`;
  const reservation = await new StorageAdmissionStore(getSqlite()).reserve({
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
  expect(reservation.decision).toBe('reserved');

  const layout = resolveWorktreeRootLayout(repoRoot);
  const admittedBase = `${layout.primaryBase}-admitted`;
  const redirectedBase = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-descendant-redirect-'));
  h.beforePinnedExecution = (workspacePath) => {
    expect(workspacePath).toBe(layout.primaryBase);
    renameSync(layout.primaryBase, admittedBase);
    symlinkSync(redirectedBase, layout.primaryBase, 'dir');
  };

  await expect(prepareLaunchWorktree({
    repoRoot,
    agentType: 'codex',
    taskName: 'descendant swap proof',
    branchName: `inline/${packetId}`,
    baseBranch: 'main',
    isolate: true,
    skipSetup: true,
    packetId,
    storageAdmissionReservationId: reservationId,
  })).rejects.toThrow('Managed workspace ownership changed before process execution.');
  expect(existsSync(path.join(redirectedBase, `packet-${packetId}`))).toBe(false);
});
