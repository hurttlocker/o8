import { describe, expect, it } from 'vitest';

import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';

describe('lane review diff summary', () => {
  it('derives review files, counts, and patches from the lane branch diff', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 80%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1,2 +1,3 @@',
      ' export const kept = true;',
      '-export const oldName = true;',
      '+export const newName = true;',
      '+export const extra = true;',
      'diff --git a/README.md b/README.md',
      'deleted file mode 100644',
      '--- a/README.md',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-# Old',
    ].join('\n');

    const summary = summarizeLaneReviewDiff(diff);

    expect(summary.additions).toBe(2);
    expect(summary.deletions).toBe(2);
    expect(summary.files).toHaveLength(2);
    expect(summary.files[0]).toMatchObject({
      path: 'src/new.ts',
      status: 'renamed',
      additions: 2,
      deletions: 1,
    });
    expect(summary.files[0]?.patch).toContain('rename to src/new.ts');
    expect(summary.files[1]).toMatchObject({
      path: 'README.md',
      status: 'deleted',
      additions: 0,
      deletions: 1,
    });
  });
});
