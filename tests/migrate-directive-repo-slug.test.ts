import { describe, expect, it } from 'vitest';

import { restampDirectiveRepoName } from '../scripts/migrate-directive-repo-slug';

describe('directive repo slug migration', () => {
  it.each([
    ['repoName: cortex-ide', 'repoName: o8'],
    ['repoName: "cortex-ide"', 'repoName: "o8"'],
    ["repoName: 'cortex-ide'", "repoName: 'o8'"],
  ])('restamps %s while preserving its quote style', (source, expected) => {
    expect(restampDirectiveRepoName(`---\n${source}\n---\n`, 'cortex-ide', 'o8'))
      .toBe(`---\n${expected}\n---\n`);
  });

  it('does not rewrite a different repo name', () => {
    expect(restampDirectiveRepoName('repoName: atlas\n', 'cortex-ide', 'o8')).toBeNull();
  });
});
