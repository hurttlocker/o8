import { describe, expect, it } from 'vitest';
import { parsePrFilePatch } from './pr-patch';
import type { PrFile } from './types';

const file: PrFile = { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -923,3 +923,3 @@\n before\n-oldValue\n+newValue\n after' };

describe('PR patches through the diff library', () => {
  it('preserves supplied lines, actual line numbers and the omitted context gap', () => {
    const diff = parsePrFilePatch(file);
    expect(diff.name).toBe(file.path);
    expect(diff.isPartial).toBe(true);
    expect(diff.hunks[0]).toMatchObject({ additionStart: 923, deletionStart: 923, collapsedBefore: 922 });
    expect(diff.deletionLines.join('')).toContain('oldValue');
    expect(diff.additionLines.join('')).toContain('newValue');
    expect(diff.additionLines.join('')).not.toContain('oldValue');
  });
  it.each(['path with spaces.ts', 'a"quote\\tab\tname.ts', 'résumé/日本語.ts', 'line\nname.ts'])('retains a quoted path and its previous name: %s', (path) => {
    const diff = parsePrFilePatch({ ...file, path, previousPath: 'old ' + path, status: 'renamed' });
    expect(diff.name).toBe(path);
    expect(diff.prevName).toBe('old ' + path);
    expect(diff.type).toBe('rename-changed');
  });
  it('distinguishes added and removed files and preserves no-newline metadata', () => {
    const added = parsePrFilePatch({ ...file, status: 'added', patch: '@@ -0,0 +1 @@\n+created\n\\ No newline at end of file' });
    const removed = parsePrFilePatch({ ...file, status: 'removed', patch: '@@ -1 +0,0 @@\n-deleted' });
    expect(added.type).toBe('new'); expect(removed.type).toBe('deleted');
    expect(added.additionLines.join('')).toBe('created');
    expect(removed.deletionLines.join('')).toContain('deleted');
  });
  it('replaces content when line counts remain equal instead of reusing old metadata', () => {
    const first = parsePrFilePatch(file);
    const next = parsePrFilePatch({ ...file, patch: file.patch!.replace('newValue', 'nextValue') });
    expect(next).not.toBe(first);
    expect(next.unifiedLineCount).toBe(first.unifiedLineCount);
    expect(next.additionLines.join('')).toContain('nextValue');
    expect(next.additionLines.join('')).not.toContain('newValue');
  });
  it('rejects missing hunk data so the view can display the original patch in place', () => {
    expect(() => parsePrFilePatch({ ...file, patch: '+not a complete patch' })).toThrow();
    expect(() => parsePrFilePatch({ ...file, patch: null })).toThrow();
  });
});
