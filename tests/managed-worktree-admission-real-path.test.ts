import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { getSqlite } from '@/lib/db';
import { prepareLaunchWorktree } from '@/lib/worktree/launch';
import {
  resolveManagedWorktreeStorageTarget,
  resolveWorktreeRootLayout,
  observeManagedWorktreeRootIdentity,
} from '@/lib/worktree/root-layout';
import { StorageAdmissionStore } from '@/lib/workspace/storage-admission';

const priorRoot = process.env.O8_WORKTREE_ROOT;

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-admission-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-q', '-m', 'base'], { cwd: repo });
  return repo;
}

async function reserve(repoRoot: string, packetId: string) {
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
  if (priorRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorRoot;
});

describe('managed worktree storage admission boundary', () => {
  it('reuses the scheduler reservation and reaches the real WorktreeManager create path', async () => {
    const repoRoot = makeRepo();
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-admission-root-'));
    const packetId = `materialize-${Date.now()}`;
    const reservationId = await reserve(repoRoot, packetId);

    const launch = await prepareLaunchWorktree({
      repoRoot,
      agentType: 'codex',
      taskName: 'materialization proof',
      branchName: `inline/${packetId}`,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      storageAdmissionReservationId: reservationId,
    });

    expect(launch?.worktree.path).toContain(resolveWorktreeRootLayout(repoRoot).primaryBase);
  }, 20_000);

  it('refuses a descendant symlink inserted after reservation before manager creation', async () => {
    const repoRoot = makeRepo();
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-redirect-root-'));
    const packetId = `redirect-${Date.now()}`;
    const reservationId = await reserve(repoRoot, packetId);
    const layout = resolveWorktreeRootLayout(repoRoot);
    const redirected = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-redirect-target-'));
    mkdirSync(layout.configuredRoot, { recursive: true });
    symlinkSync(redirected, path.join(layout.configuredRoot, layout.repoKey), 'dir');

    await expect(prepareLaunchWorktree({
      repoRoot,
      agentType: 'codex',
      taskName: 'redirect proof',
      branchName: `inline/${packetId}`,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      storageAdmissionReservationId: reservationId,
    })).rejects.toThrow(/redirected or is not a directory|unsafe ancestor/);
  }, 20_000);

  it('refuses a same-volume configured-root replacement after reservation', async () => {
    const repoRoot = makeRepo();
    const configuredRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-root-swap-'));
    process.env.O8_WORKTREE_ROOT = configuredRoot;
    const packetId = `root-swap-${Date.now()}`;
    const reservationId = await reserve(repoRoot, packetId);
    const originalRoot = `${configuredRoot}-admitted`;
    const redirectedRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-managed-root-redirect-'));
    renameSync(configuredRoot, originalRoot);
    symlinkSync(redirectedRoot, configuredRoot, 'dir');

    await expect(prepareLaunchWorktree({
      repoRoot,
      agentType: 'codex',
      taskName: 'root swap proof',
      branchName: `inline/${packetId}`,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      storageAdmissionReservationId: reservationId,
    })).rejects.toThrow(/storage admission proof|root was replaced|root identity changed/);
    expect(existsSync(path.join(
      redirectedRoot,
      resolveWorktreeRootLayout(repoRoot).repoKey,
    ))).toBe(false);
  }, 20_000);
});
