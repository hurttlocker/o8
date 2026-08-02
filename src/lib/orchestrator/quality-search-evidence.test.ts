import { describe, expect, it } from 'vitest';

import { qualitySearchEvidenceInternals } from '@/lib/orchestrator/quality-search-evidence';

describe('quality-search evidence projection', () => {
  it('sums text numstat and ignores binary markers', () => {
    expect(qualitySearchEvidenceInternals.parseNumstat([
      '12\t3\tsrc/a.ts',
      '-\t-\tpublic/image.png',
      '4\t0\ttests/a.test.ts',
    ].join('\n'))).toEqual({ additions: 16, deletions: 3 });
  });

  it('counts route files and newly exported symbols as public-surface proxies', () => {
    expect(qualitySearchEvidenceInternals.countNewPublicSurfaces(
      ['src/app/api/items/route.ts', 'src/lib/item.ts', 'src/lib/item.test.ts'],
      ['+export function createItem() {}', '+export const fixture = {};'],
    )).toBe(3);
  });
});
