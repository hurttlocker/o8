import { describe, expect, it } from 'vitest';
import { classifyDiffPath, buildDiffBreakdown } from './diff-breakdown';
const file = (path: string, additions: number, deletions: number) => ({ path, additions, deletions });
describe('diff breakdown', () => {
  it.each([
    ['src/main.ts', 'Code'], ['src/app/page.tsx', 'Code'], ['lib/parser.rs', 'Code'],
    ['tests/unit/parser.ts', 'Tests'], ['src/parser.spec.ts', 'Tests'], ['pkg/parser_test.go', 'Tests'], ['tests/test_parser.py', 'Tests'],
    ['tests/__mocks__/api.ts', 'Mocks'], ['src/api.mock.ts', 'Mocks'], ['test/fixtures/request.json', 'Mocks'],
    ['docs/testing.md', 'Other'], ['package-lock.json', 'Other'], ['assets/icon.png', 'Other'], ['testimonials/main.ts', 'Code'],
  ])('classifies %s as %s', (path, category) => expect(classifyDiffPath(path)).toBe(category));
  it('conserves additions and deletions without requiring a text patch', () => {
    const result = buildDiffBreakdown([file('main.ts', 285, 40), file('main.test.ts', 150, 1), file('__mocks__/api.ts', 69, 64), file('icon.png', 0, 0)], 4, 504, 105);
    expect(result.complete).toBe(true);
    expect(result.rows).toEqual([
      { category: 'Code', files: 1, additions: 285, deletions: 40 },
      { category: 'Tests', files: 1, additions: 150, deletions: 1 },
      { category: 'Mocks', files: 1, additions: 69, deletions: 64 },
      { category: 'Other', files: 1, additions: 0, deletions: 0 },
    ]);
  });
  it('marks capped and inconsistent metadata as partial, without inventing a remainder category', () => {
    const files = [file('main.ts', 4, 1)];
    expect(buildDiffBreakdown(files, 101, 200, 40).complete).toBe(false);
    expect(buildDiffBreakdown(files, 1, 5, 1).complete).toBe(false);
    expect(buildDiffBreakdown(files, 1, 4, 1).complete).toBe(true);
  });
  it('uses the current path for renamed files and handles empty totals', () => {
    expect(buildDiffBreakdown([{ ...file('test/moved.ts', 0, 0), previousPath: 'src/old.ts' }], 1, 0, 0).rows[0].category).toBe('Tests');
    expect(buildDiffBreakdown([], 0, 0, 0)).toMatchObject({ complete: true, rows: [] });
  });
});
