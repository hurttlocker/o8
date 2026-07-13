import { describe, it, expect } from 'vitest';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { deriveEditCounts, deriveFileEdits, isFileEditCall } from './file-edits';

function tool(partial: Partial<MobileTranscriptToolCall> & { name: string }): MobileTranscriptToolCall {
  return { status: 'done', ...partial };
}

describe('deriveEditCounts — honest counts from the edit payload only', () => {
  it('derives +added/−removed from an Edit old_string→new_string line delta', () => {
    expect(deriveEditCounts('Edit', { old_string: 'a\nb', new_string: 'a\nB\nc\nd' })).toEqual({
      added: 4,
      removed: 2,
    });
  });

  it('sums a MultiEdit across its edits', () => {
    const counts = deriveEditCounts('MultiEdit', {
      edits: [
        { old_string: 'x', new_string: 'x\ny' },
        { old_string: 'p\nq\nr', new_string: 's' },
      ],
    });
    expect(counts).toEqual({ added: 2 + 1, removed: 1 + 3 });
  });

  it('does not count a phantom trailing-newline line', () => {
    expect(deriveEditCounts('Edit', { old_string: '', new_string: 'one\n' })).toEqual({
      added: 1,
      removed: 0,
    });
  });

  it('returns null for a Write (whole-file overwrite — prior content unknown)', () => {
    expect(deriveEditCounts('Write', { content: 'line1\nline2' })).toBeNull();
  });

  it('returns null when the args carry no edit strings', () => {
    expect(deriveEditCounts('apply_patch', { patch: '...' })).toBeNull();
  });
});

describe('deriveFileEdits — which tool calls become file-edit rows', () => {
  it('turns Edit/Write/MultiEdit calls with a real path into rows, in order', () => {
    const rows = deriveFileEdits([
      tool({ id: 't1', name: 'Edit', status: 'running', args: { file_path: '/repo/src/main.tsx', old_string: 'a', new_string: 'a\nb' } }),
      tool({ id: 't2', name: 'Write', args: { file_path: '/repo/README.md', content: 'hi' } }),
      tool({ id: 't3', name: 'Read', args: { file_path: '/repo/x.ts' } }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 't1', basename: 'main.tsx', status: 'editing', added: 2, removed: 1 });
    // Write has a path but no derivable counts → row without numbers.
    expect(rows[1]).toMatchObject({ id: 't2', basename: 'README.md', status: 'edited' });
    expect(rows[1].added).toBeUndefined();
    expect(rows[1].removed).toBeUndefined();
  });

  it('maps an errored edit call to status "error"', () => {
    const rows = deriveFileEdits([
      tool({ name: 'Edit', status: 'error', args: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' } }),
    ]);
    expect(rows[0].status).toBe('error');
  });

  it('skips write-kind calls with no derivable file path (they stay in the cluster)', () => {
    const calls = [tool({ name: 'apply_patch', args: { patch: '@@ -1 +1 @@' } })];
    expect(deriveFileEdits(calls)).toHaveLength(0);
    expect(isFileEditCall(calls[0])).toBe(false);
  });

  it('does not treat a Read as a file edit', () => {
    expect(isFileEditCall(tool({ name: 'Read', args: { file_path: '/repo/a.ts' } }))).toBe(false);
  });
});
