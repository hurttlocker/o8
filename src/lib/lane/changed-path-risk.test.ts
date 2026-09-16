import { describe, expect, it } from 'vitest';

import { riskForChangedPaths } from './changed-path-risk';

describe('riskForChangedPaths', () => {
  it('rates a diff under docs/ only as low', () => {
    expect(riskForChangedPaths([{ path: 'docs/user/guide.txt' }, { path: 'docs/internals/a.md' }], 'high')).toBe('low');
  });

  it('rates a diff of markdown files only as low', () => {
    expect(riskForChangedPaths([{ path: 'README.md' }, { path: 'src/lib/lane/NOTES.MD' }], 'high')).toBe('low');
  });

  it('keeps the fallback risk when docs are mixed with code', () => {
    expect(riskForChangedPaths([{ path: 'docs/a.md' }, { path: 'src/lib/lane/commands.ts' }], 'high')).toBe('high');
  });

  it('keeps the fallback risk for an empty file list', () => {
    expect(riskForChangedPaths([], 'high')).toBe('high');
    expect(riskForChangedPaths([], 'medium')).toBe('medium');
  });
});
