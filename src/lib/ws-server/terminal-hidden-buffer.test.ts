import { describe, expect, it } from 'vitest';
import { TerminalHiddenBuffer } from './terminal-hidden-buffer';

describe('TerminalHiddenBuffer', () => {
  it('preserves byte order across coalesced chunks', () => {
    const buffer = new TerminalHiddenBuffer(16);
    buffer.append(Buffer.from([0x1b, 0x5b]));
    buffer.append(Buffer.from([0x33, 0x31, 0x6d]));

    expect([...buffer.drain()]).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
    expect(buffer.byteLength).toBe(0);
  });

  it('drops the oldest bytes and reports the exact overflow', () => {
    const buffer = new TerminalHiddenBuffer(8);
    buffer.append('abcd');
    const result = buffer.append('efghij');

    expect(result).toEqual({ droppedBytes: 2, reportOverflow: true, retainedBytes: 8 });
    expect(buffer.drain().toString('utf8')).toBe('cdefghij');
  });

  it('reports the first drop once in each hidden period', () => {
    const buffer = new TerminalHiddenBuffer(4);
    buffer.beginHiddenPeriod();

    expect(buffer.append('abcde').reportOverflow).toBe(true);
    expect(buffer.append('f').reportOverflow).toBe(false);
    buffer.beginHiddenPeriod();
    expect(buffer.append('g').reportOverflow).toBe(true);
  });
});
