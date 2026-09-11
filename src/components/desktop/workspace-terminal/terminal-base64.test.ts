import { describe, expect, it } from 'vitest';
import { decodeTerminalBase64 } from './terminal-base64';

describe('terminal base64 decoding', () => {
  it('preserves every byte across a large coalesced delivery', () => {
    const bytes = Uint8Array.from({ length: 131_073 }, (_, index) => index % 256);
    expect(decodeTerminalBase64(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
  });

  it.each(['', 'A', 'Unicode: café 中文', '\x1b[31mred\x1b[0m\r\n'])('preserves text %j', (text) => {
    expect(new TextDecoder().decode(decodeTerminalBase64(Buffer.from(text).toString('base64')))).toBe(text);
  });

  it('rejects malformed input instead of returning partial bytes', () => {
    expect(() => decodeTerminalBase64('invalid!')).toThrow();
  });
});
