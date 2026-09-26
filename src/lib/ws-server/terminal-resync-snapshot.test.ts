import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { formatTmuxResyncSnapshot, parseTmuxSnapshotCursor } from './terminal-resync-snapshot';

describe('tmux terminal resync snapshot', () => {
  it('restores the shell cursor after captured blank screen rows', async () => {
    const prompt = 'user@host project %';
    const cursor = parseTmuxSnapshotCursor(`${prompt.length} 0 80 24`);
    expect(cursor).not.toBeNull();
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const captured = `${prompt}${'\n'.repeat(24)}`;
    const snapshot = formatTmuxResyncSnapshot(captured, cursor, { cols: 80, rows: 24 });
    await new Promise<void>((resolve) => term.write(snapshot, resolve));
    expect(term.buffer.active.cursorY).toBe(0);
    expect(term.buffer.active.cursorX).toBe(prompt.length);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(prompt);
    await new Promise<void>((resolve) => term.write('x', resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(`${prompt}x`);
    term.dispose();
  });

  it('does not restore a cursor from an invalid or differently sized pane', () => {
    expect(parseTmuxSnapshotCursor('81 0 80 24')).toBeNull();
    expect(parseTmuxSnapshotCursor('0 0 0 24')).toBeNull();
    expect(formatTmuxResyncSnapshot('prompt\n\n', parseTmuxSnapshotCursor('3 0 80 24'), { cols: 60, rows: 24 }))
      .toBe('prompt\r\n');
  });
});
