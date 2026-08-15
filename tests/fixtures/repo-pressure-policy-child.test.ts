import { describe, it } from 'vitest';

describe.skipIf(process.env.O8_TEST_REPO_POLICY_CHILD !== '1')('repository policy child', () => {
  it('persists the repository opt-out in another process', async () => {
    const registry = await import('@/lib/repos/registry');
    if (process.env.O8_TEST_REPO_POLICY_ACTION === 'touch') {
      await registry.touchRepo('repo-pressure', '2026-08-15T00:00:00.000Z');
    } else {
      await registry.updateRepo('repo-pressure', { storagePressureParkingDisabled: true });
    }
  });
});
