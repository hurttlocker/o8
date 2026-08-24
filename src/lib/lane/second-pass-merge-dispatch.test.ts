import { describe, expect, it } from 'vitest';

import { readMergeDispatchRecovery } from './second-pass-merge-dispatch';

describe('readMergeDispatchRecovery', () => {
  it('keeps an inconclusive branch probe inside the bounded retry path', () => {
    expect(readMergeDispatchRecovery('branch_probe_unknown')).toBe('branch_probe_unknown');
    expect(readMergeDispatchRecovery('detached_worktree_head')).toBeNull();
  });
});
