import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalInput } from './terminal-input.js';

afterEach(() => vi.useRealTimers());

describe('bracketed terminal paste', () => {
  it('keeps split markers and pasted newlines out of the key stream', async () => {
    const source = new PassThrough();
    const input = terminalInput(source as unknown as NodeJS.ReadStream);
    const pasted: string[] = [];
    const keys: string[] = [];
    input.paste.on('paste', (value) => pasted.push(value));
    input.stream.on('data', (value) => keys.push(value.toString()));
    source.write('\x1b'); source.write('[20'); source.write('0~/quit\r\n');
    source.write('👩🏽‍💻\x1b[2'); source.write('01~');
    await new Promise((resolve) => setImmediate(resolve));
    expect(pasted).toEqual(['/quit\r\n👩🏽‍💻']);
    expect(keys).toEqual([]);
    input.close();
  });

  it('still delivers a lone Escape as a key', async () => {
    vi.useFakeTimers();
    const source = new PassThrough();
    const input = terminalInput(source as unknown as NodeJS.ReadStream);
    let keys = '';
    input.stream.on('data', (value) => { keys += value.toString(); });
    source.write('\x1b');
    await vi.advanceTimersByTimeAsync(30);
    expect(keys).toBe('\x1b');
    input.close();
  });
});
