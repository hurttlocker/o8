import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorktrees } from './worktrees';

describe('review worktree navigation identity', () => {
  it('keeps the full path separate from its display label, including spaces and detached checkouts', () => {
    const primary = path.join(os.homedir(), 'sample');
    const linked = path.join(os.homedir(), 'review copy');
    const result = parseWorktrees([
      `worktree ${primary}\nHEAD abc123456789\nbranch refs/heads/main`,
      `worktree ${linked}\nHEAD def123456789\ndetached\nlocked in use`,
      `worktree ${path.join(os.tmpdir(), 'missing')}\nbranch refs/heads/old\nprunable missing`,
    ].join('\n\n'), linked + path.sep);
    expect(result[0]).toMatchObject({ path: '~/sample', absolutePath: primary, branch: 'main', isCurrent: false });
    expect(result[1]).toMatchObject({ path: '~/review copy', absolutePath: linked, head: 'def1234', isDetached: true, isCurrent: true, lockedReason: 'in use' });
    expect(result[2].prunableReason).toBe('missing');
  });
});
