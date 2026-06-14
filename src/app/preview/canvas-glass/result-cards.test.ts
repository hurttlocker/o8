import { describe, it, expect } from 'vitest';
import { emptyTurnTools, recordTool, recordToolResult, synthesizeResultEntries } from './result-cards';

describe('result-cards turn accumulator', () => {
  it('folds an Edit into a file + net diff stats', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Edit', { file_path: '/repo/src/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' });
    expect(acc.files).toEqual(['/repo/src/a.ts']);
    expect(acc.adds).toBe(4);
    expect(acc.dels).toBe(2);
  });

  it('counts a Write as pure adds', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Write', { file_path: '/repo/new.ts', content: 'a\nb\nc' });
    expect(acc.adds).toBe(3);
    expect(acc.dels).toBe(0);
  });

  it('sums a MultiEdit edit list', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'MultiEdit', { file_path: '/repo/m.ts', edits: [
      { old_string: 'x', new_string: 'x\ny' },
      { old_string: 'p\nq', new_string: 'p' },
    ] });
    expect(acc.adds).toBe(2 + 1);
    expect(acc.dels).toBe(1 + 2);
  });

  it('dedups repeated edits to the same file but keeps accumulating stats', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'a\nb' });
    recordTool(acc, 'Edit', { file_path: '/repo/a.ts', old_string: 'c', new_string: 'c\nd' });
    expect(acc.files).toEqual(['/repo/a.ts']);
    expect(acc.adds).toBe(4);
    expect(acc.dels).toBe(2);
  });

  it('ignores non-edit tools (Read/Bash/Grep)', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Read', { file_path: '/repo/a.ts' });
    recordTool(acc, 'Bash', { command: 'ls' });
    expect(acc.files).toEqual([]);
    expect(acc.adds).toBe(0);
  });

  it('captures a PR from gh pr create output (URL form)', () => {
    const acc = emptyTurnTools();
    recordToolResult(acc, 'Bash', { command: 'gh pr create --fill' }, 'https://github.com/hurttlocker/o8/pull/1234\n');
    expect(acc.pr).toEqual({ number: 1234, repo: 'hurttlocker/o8' });
  });

  it('does not capture a PR from an unrelated shell', () => {
    const acc = emptyTurnTools();
    recordToolResult(acc, 'Bash', { command: 'git status' }, 'nothing to commit');
    expect(acc.pr).toBeNull();
  });

  it('synthesizes a files card with stats + a PR card', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Write', { file_path: '/repo/src/dock.tsx', content: 'a\nb\nc' });
    recordTool(acc, 'Edit', { file_path: '/repo/src/page.tsx', old_string: 'x', new_string: 'x\ny' });
    recordToolResult(acc, 'Bash', { command: 'gh pr create' }, 'https://github.com/o/r/pull/7');
    const entries = synthesizeResultEntries(acc);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'result', kind: 'files', title: 'Edited 2 files', files: ['src/dock.tsx', 'src/page.tsx'] });
    expect(entries[0]).toMatchObject({ adds: 5, dels: 1 }); // Write 3 + Edit's new "x\ny" 2 = 5 adds
    expect(entries[1]).toMatchObject({ role: 'result', kind: 'pr', prNumber: 7, repo: 'o/r', prState: 'open' });
  });

  it('emits nothing for a read-only / Q&A turn', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Read', { file_path: '/repo/a.ts' });
    expect(synthesizeResultEntries(acc)).toEqual([]);
  });

  it('omits diff stats when no line deltas were parsed', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Edit', { file_path: '/repo/a.ts' }); // no old/new strings
    const [card] = synthesizeResultEntries(acc);
    expect(card).toMatchObject({ kind: 'files', title: 'Edited 1 file' });
    expect(card).not.toHaveProperty('adds');
  });

  it('captures a screencapture output path; pathless captures get nothing', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'o8_view_screenshot', undefined); // base64, truncated off the stream → not showable
    recordTool(acc, 'Bash', { command: 'screencapture -x /tmp/shot.png' });
    expect(acc.screenshotPaths).toEqual(['/tmp/shot.png']);
    expect(acc.files).toEqual([]); // a screenshot is not a file edit
  });

  it('handles array-form shell commands (Codex) and a ~ path', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'shell', { command: ['screencapture', '-x', '~/Desktop/c.png'] });
    expect(acc.screenshotPaths).toEqual(['~/Desktop/c.png']);
  });

  it('captures o8_view_screenshot from the saved-path tool-result (MCP path)', () => {
    const acc = emptyTurnTools();
    // The orchestrator emitter swaps the base64 for the persisted file path.
    recordToolResult(acc, 'o8_view_screenshot', undefined, '/tmp/o8-screenshots/1718300000-ab12cd.png');
    expect(acc.screenshotPaths).toEqual(['/tmp/o8-screenshots/1718300000-ab12cd.png']);
    const [card] = synthesizeResultEntries(acc);
    expect(card).toMatchObject({ role: 'result', kind: 'screenshot', title: '' });
    expect((card as { src?: string }).src).toContain('serve-image?path=');
  });

  it('synthesizes image-led screenshot cards (real served src, no label) per capture', () => {
    const acc = emptyTurnTools();
    recordTool(acc, 'Bash', { command: 'screencapture -x ~/Desktop/a.png' });
    recordTool(acc, 'Bash', { command: 'screencapture -x /tmp/b.png' });
    const entries = synthesizeResultEntries(acc);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'result', kind: 'screenshot', title: '' });
    expect((entries[0] as { src?: string }).src).toBe('/api/panel/serve-image?path=' + encodeURIComponent('~/Desktop/a.png'));
    expect((entries[1] as { src?: string }).src).toBe('/api/panel/serve-image?path=' + encodeURIComponent('/tmp/b.png'));
  });
});
