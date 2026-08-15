import { writeFileSync } from 'node:fs';

import { describe, it, vi } from 'vitest';

vi.mock('@/lib/workspace/exact-managed-directory-retirement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/exact-managed-directory-retirement')>();
  return {
    ...actual,
    retireExactManagedDirectory: async (
      input: Parameters<typeof actual.retireExactManagedDirectory>[0],
    ) => actual.retireExactManagedDirectory({
      ...input,
      afterRetirementRename: async () => {
        writeFileSync(process.env.O8_TEST_RETIRE_CRASH_MARKER!, 'renamed');
        process.kill(process.pid, 'SIGKILL');
        await new Promise<never>(() => {});
      },
    }),
  };
});

const enabled = Boolean(
  process.env.O8_TEST_RETIRE_CRASH_REPO
  && process.env.O8_TEST_RETIRE_CRASH_MARKER
  && process.env.O8_TEST_RETIRE_CRASH_WORKTREE,
);

describe.skipIf(!enabled)('managed cleanup crash child', () => {
  it('crashes after exact retirement rename', async () => {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    await new WorktreeManager(process.env.O8_TEST_RETIRE_CRASH_REPO!).cleanup(
      process.env.O8_TEST_RETIRE_CRASH_WORKTREE!,
      {
        force: true,
        overrideLiveGuard: true,
        workspaceRetirementAction: process.env.O8_TEST_RETIRE_CRASH_ACTION === 'pr'
          ? 'pr'
          : process.env.O8_TEST_RETIRE_CRASH_ACTION === 'merge' ? 'merge' : 'cleanup',
      },
    );
  }, 60_000);
});
