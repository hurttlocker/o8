import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { ClientTerminalHiddenBuffer } from './terminal-hidden-buffer';
import { disposeTerminalOutput, resetTerminalOutput, setTerminalInputDisabled, writeTerminalOutput } from './terminal-output-writer';

describe('terminal output provenance', () => {
  it('paints historical queries without replying and still answers live CLI queries', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    try {
      await new Promise<void>((resolve) => writeTerminalOutput(term, 'saved output\x1b[c\x1b[>c\x1b[6n', resolve, true));
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('saved output');
      expect(sent).toEqual([]);
      await new Promise<void>((resolve) => writeTerminalOutput(term, '\x1b[c\x1b[>c', resolve));
      expect(sent).toEqual(['\x1b[?1;2c', '\x1b[>0;276;0c']);
      term.input('typed input');
      expect(sent.at(-1)).toBe('typed input');
    } finally { disposeTerminalOutput(term); term.dispose(); }
  });

  it('retains replay provenance through hidden-buffer overflow and fragmented queries', async () => {
    const buffer = new ClientTerminalHiddenBuffer(32);
    buffer.append(new TextEncoder().encode('old '.repeat(10)));
    buffer.append(new TextEncoder().encode('saved\x1b['), true);
    buffer.append(new TextEncoder().encode('c'), true);
    buffer.append(new TextEncoder().encode('\x1b[c'));
    const chunks = buffer.drainChunks();
    expect(chunks.map((chunk) => chunk.historical)).toEqual([false, true, false]);
    expect(new TextDecoder().decode(chunks[1].data)).toBe('saved\x1b[c');
    expect(chunks.reduce((size, chunk) => size + chunk.data.byteLength, 0)).toBe(32);
    const term = new Terminal({ allowProposedApi: true });
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    try {
      await Promise.all(chunks.map((chunk) => new Promise<void>((resolve) => writeTerminalOutput(term, chunk.data, resolve, chunk.historical))));
      expect(sent).toEqual(['\x1b[?1;2c']);
      expect(buffer.byteLength).toBe(0);
    } finally { disposeTerminalOutput(term); term.dispose(); }
  });

  it('orders asynchronous live and historical parsing without muting a pending live reply', () => {
    const queued: Array<{ data: string | Uint8Array; done?: () => void }> = [];
    const parsed: Array<{ text: string; disabled: boolean }> = [];
    const term = { options: { disableStdin: false }, write: (data: string | Uint8Array, done?: () => void) => queued.push({ data, done }) };
    const complete = () => { const next = queued.shift()!; parsed.push({ text: String(next.data), disabled: term.options.disableStdin }); next.done?.(); };
    writeTerminalOutput(term, 'live before');
    writeTerminalOutput(term, 'old queries', undefined, true);
    writeTerminalOutput(term, 'live after');
    expect(term.options.disableStdin).toBe(false);
    complete(); expect(term.options.disableStdin).toBe(true);
    complete(); expect(term.options.disableStdin).toBe(false);
    complete();
    expect(parsed).toEqual([{ text: 'live before', disabled: false }, { text: 'old queries', disabled: true }, { text: 'live after', disabled: false }]);
  });

  it('resets the screen after earlier queued output finishes, before painting the snapshot', () => {
    const callbacks: Array<(() => void) | undefined> = [];
    let screen = '';
    const term = { options: { disableStdin: false }, reset: () => { screen = ''; }, write: (data: string | Uint8Array, done?: () => void) => { callbacks.push(() => { screen += String(data); done?.(); }); } };
    writeTerminalOutput(term, 'earlier output');
    resetTerminalOutput(term, 'snapshot');
    callbacks[0]?.();
    expect(screen).toBe('');
    callbacks[1]?.();
    expect(screen).toBe('snapshot');
  });

  it('keeps a newer input lock when replay finishes and ignores disposed write callbacks', () => {
    const callbacks: Array<(() => void) | undefined> = [];
    const writes: string[] = [];
    const term = { options: { disableStdin: false }, write: (data: string | Uint8Array, done?: () => void) => { writes.push(String(data)); callbacks.push(done); } };
    writeTerminalOutput(term, 'history', undefined, true);
    setTerminalInputDisabled(term, true);
    callbacks[0]?.();
    expect(term.options.disableStdin).toBe(true);
    setTerminalInputDisabled(term, false);
    expect(term.options.disableStdin).toBe(false);
    writeTerminalOutput(term, 'more history', undefined, true);
    writeTerminalOutput(term, 'queued after unmount');
    disposeTerminalOutput(term);
    callbacks[1]?.();
    expect(writes).toEqual(['history', 'more history']);
  });
});
