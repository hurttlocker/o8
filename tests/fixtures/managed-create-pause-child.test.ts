import { existsSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const enabled = Boolean(
  process.env.O8_TEST_CREATE_PAUSE_REPO
  && process.env.O8_TEST_CREATE_PAUSE_MARKER
  && process.env.O8_TEST_CREATE_PAUSE_RELEASE,
);

describe.skipIf(!enabled)('managed create pause child', () => {
  it('holds the real create flow after Git materialization', async () => {
    const repo = process.env.O8_TEST_CREATE_PAUSE_REPO!;
    const marker = process.env.O8_TEST_CREATE_PAUSE_MARKER!;
    const release = process.env.O8_TEST_CREATE_PAUSE_RELEASE!;
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const prototype = WorktreeManager.prototype as unknown as {
      bindCreatedMaterializationIdentity: (
        id: string,
        identity: { device: number; inode: number; canonicalPath: string },
      ) => Promise<void>;
    };
    const bind = prototype.bindCreatedMaterializationIdentity;
    Object.defineProperty(WorktreeManager.prototype, 'bindCreatedMaterializationIdentity', {
      value: async function pauseBeforeBind(
        id: string,
        identity: { device: number; inode: number; canonicalPath: string },
      ) {
        writeFileSync(marker, JSON.stringify({ id, path: identity.canonicalPath }));
        while (!existsSync(release)) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return bind.call(this, id, identity);
      },
    });
    const created = await new WorktreeManager(repo).create({
      agentType: 'codex',
      taskName: 'concurrent create',
      baseBranch: 'main',
      branchName: 'inline/concurrent-create',
      managed: true,
      skipSetup: true,
      isolationPreference: 'git-worktree',
    });
    expect(created.status).toBe('ready');
  }, 60_000);
});
