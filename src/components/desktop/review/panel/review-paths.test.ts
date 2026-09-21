import { describe, expect, it } from 'vitest';

import { reviewPathCandidates, reviewRowPathForSourcePath } from './review-paths';

describe('review path mapping', () => {
  it('maps either side of a renamed source path to the rendered review row key', () => {
    const rename = 'src/old.ts → src/new.ts';

    expect(reviewPathCandidates(rename)).toEqual([rename, 'src/old.ts', 'src/new.ts']);
    expect(reviewRowPathForSourcePath('src/old.ts', [rename])).toBe(rename);
    expect(reviewRowPathForSourcePath('src/new.ts', [rename])).toBe(rename);
  });
});
