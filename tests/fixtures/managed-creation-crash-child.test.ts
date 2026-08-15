import { writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/apfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree/apfs')>();
  if (process.env.O8_TEST_CRASH_ISOLATION !== 'apfs-cow-clone') return actual;
  return {
    ...actual,
    getApfsCowCapability: vi.fn(async () => ({
      macos: true,
      apfs: true,
      sameVolume: true,
      canCowClone: true,
    })),
  };
});

const enabled = Boolean(
  process.env.O8_TEST_CRASH_REPO
  && process.env.O8_TEST_CRASH_MARKER
  && process.env.O8_TEST_CRASH_PACKET,
);

describe.skipIf(!enabled)('managed creation crash child', () => {
  it('crashes during setup after persisting exact materialization ownership', async () => {
    const repoRoot = process.env.O8_TEST_CRASH_REPO!;
    const packetId = process.env.O8_TEST_CRASH_PACKET!;
    const isolationKind = process.env.O8_TEST_CRASH_ISOLATION === 'apfs-cow-clone'
      ? 'apfs-cow-clone' as const
      : 'git-worktree' as const;
    const { getSqlite } = await import('@/lib/db');
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
    const {
      observeManagedWorktreeRootIdentity,
      resolveManagedWorktreeStorageTarget,
    } = await import('@/lib/worktree/root-layout');
    const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');
    const reservationId = `packet-storage:${packetId}:1`;
    const admission = await new StorageAdmissionStore(getSqlite()).reserve({
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
    expect(admission.decision).toBe('reserved');
    Object.defineProperty(WorktreeManager.prototype, 'bindCreatedMaterializationIdentity', {
      value: async function crashBeforeFinalIdentityBind(
        id: string,
        identity: { device: number; inode: number; canonicalPath: string },
      ) {
      const entry = await withWorktreeMetaTransaction(
        repoRoot,
        async (transaction) => (await transaction.readAll())[id] ?? null,
      );
      expect(entry?.materializationIdentity).toBeTruthy();
      writeFileSync(process.env.O8_TEST_CRASH_MARKER!, JSON.stringify({
        id,
        worktreePath: identity.canonicalPath,
        identity: entry!.materializationIdentity,
        isolationKind,
      }));
      process.kill(process.pid, 'SIGKILL');
      await new Promise<never>(() => {});
      },
    });
    await new WorktreeManager(repoRoot).create({
      agentType: 'codex',
      taskName: `crash ${isolationKind}`,
      packetId,
      branchName: `inline/${packetId}`,
      baseBranch: 'main',
      managed: true,
      isolationPreference: isolationKind,
      storageAdmissionReservationId: reservationId,
    });
  }, 60_000);
});
