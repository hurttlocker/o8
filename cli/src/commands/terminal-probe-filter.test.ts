import { describe, expect, it } from 'vitest';
import { TerminalProbeReplyFilter } from './terminal-probe-filter';

describe('remote terminal probe reply filter', () => {
  it('drops fragmented attach replies while preserving typing and navigation', () => {
    const filter = new TerminalProbeReplyFilter();
    expect(filter.push('\x1b[?62;4;')).toBe('');
    expect(filter.push('9;22c\x1b[>0;276;0c')).toBe('');
    expect(filter.push('\x1b]10;rgb:e8e8/ecec/')).toBe('');
    expect(filter.push('f2f2\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe('');
    expect(filter.push('\x1b[8;16;39t\x1b[4;368;313t')).toBe('');
    expect(filter.push('echo okay\x1b[A\n')).toBe('echo okay\x1b[A\n');
    expect(filter.hasPending).toBe(false);
  });

  it('keeps an Escape key and drops incomplete identified replies on timeout', () => {
    const filter = new TerminalProbeReplyFilter();
    expect(filter.push('\x1b')).toBe('');
    expect(filter.pendingDelayMs).toBe(20);
    expect(filter.flush()).toBe('\x1b');
    expect(filter.push('\x1b[?62;4')).toBe('');
    expect(filter.pendingDelayMs).toBe(100);
    expect(filter.flush()).toBe('');
    expect(filter.push('typed')).toBe('typed');
  });

  it('preserves unrelated ANSI input and OSC traffic', () => {
    const filter = new TerminalProbeReplyFilter();
    expect(filter.push('\x1b[1;5C\x1b]52;c;clip\x07x')).toBe('\x1b[1;5C\x1b]52;c;clip\x07x');
  });
});
