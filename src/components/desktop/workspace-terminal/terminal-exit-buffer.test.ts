import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { retainTerminalExitBuffer } from './terminal-exit-buffer';

const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)('@xterm/headless') as { Terminal: new (options: Record<string, unknown>) => Terminal };

describe('terminal exit buffer through the real xterm parser', () => {
  it('retains final alternate-screen output before tmux clears it, including a single batched write', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 12, allowProposedApi: true });
    const retained = retainTerminalExitBuffer(term);
    try {
      await new Promise<void>((resolve) => term.write('\x1b[?1049hO8-FINAL-MARKER\r\nlast output\x1b[H\x1b[2J\x1b[?1049l\x1b[H\x1b[2J[exited]', resolve));
      expect(term.buffer.active.type).toBe('normal');
      expect(retained.read()).toContain('O8-FINAL-MARKER');
      expect(retained.read()).toContain('last output');
    } finally { retained.dispose(); term.dispose(); }
  });

  it('keeps later normal-screen output instead of restoring a stale interactive screen', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 12, allowProposedApi: true });
    const retained = retainTerminalExitBuffer(term);
    try {
      await new Promise<void>((resolve) => term.write('\x1b[?1049hEDITOR-SCREEN\x1b[?1049lACTUAL-FINAL-OUTPUT', resolve));
      expect(retained.read()).toContain('ACTUAL-FINAL-OUTPUT');
      expect(retained.read()).not.toContain('EDITOR-SCREEN');
    } finally { retained.dispose(); term.dispose(); }
  });

  it('retains the interactive reply when tmux restores startup history before its exit marker', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 12, allowProposedApi: true });
    const retained = retainTerminalExitBuffer(term);
    try {
      await new Promise<void>((resolve) => term.write('STARTUP\r\n\x1b[?1049hSTARTUP\r\nYou typed: FINAL\r\n\x1b[?1049l[exited]', resolve));
      expect(retained.read()).toContain('You typed: FINAL');
    } finally { retained.dispose(); term.dispose(); }
  });

  it('keeps new normal-screen output even when it ends with the exit marker', async () => {
    const term = new HeadlessTerminal({ cols: 80, rows: 12, allowProposedApi: true });
    const retained = retainTerminalExitBuffer(term);
    try {
      await new Promise<void>((resolve) => term.write('STARTUP\r\n\x1b[?1049hOLD-EDITOR\x1b[?1049lFINAL-NORMAL-OUTPUT\r\n[exited]', resolve));
      expect(retained.read()).toContain('FINAL-NORMAL-OUTPUT');
      expect(retained.read()).not.toContain('OLD-EDITOR');
    } finally { retained.dispose(); term.dispose(); }
  });
});
