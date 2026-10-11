import { describe, expect, it } from 'vitest';

import { truncateText } from './text';

function hasIsolatedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe('truncateText', () => {
  it('returns empty string for nullish or blank input', () => {
    expect(truncateText(null, 10)).toBe('');
    expect(truncateText(undefined, 10)).toBe('');
    expect(truncateText('', 10)).toBe('');
    expect(truncateText('   ', 10, { normalizeWhitespace: true })).toBe('');
  });

  it('returns empty string for zero or negative budgets', () => {
    expect(truncateText('hello', 0)).toBe('');
    expect(truncateText('hello', -1)).toBe('');
    expect(truncateText('👍', 0)).toBe('');
  });

  it('preserves short and exact-fit input unchanged', () => {
    expect(truncateText('hi', 10)).toBe('hi');
    expect(truncateText('hello', 5)).toBe('hello');
    expect(truncateText('👍', 2)).toBe('👍');
  });

  it('fits a one-character limit with only the ellipsis', () => {
    expect(truncateText('hello', 1)).toBe('…');
    expect(truncateText('👍x', 1)).toBe('…');
  });

  it('keeps truncation within the UTF-16 budget including the ellipsis', () => {
    const out = truncateText('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('does not split a surrogate pair at the cutoff', () => {
    // "ab👍cd" code units: a b [HI LO] c d (length 6).
    // Budget 4 → content end=3 lands on the high surrogate; naive slice
    // would keep an isolated HI. We drop the whole pair → "ab…".
    const input = 'ab👍cd';
    expect(input.length).toBe(6);

    const out = truncateText(input, 4);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(hasIsolatedSurrogate(out)).toBe(false);
    expect(out).toBe('ab…');

    // Budget 5 fits the whole pair before the ellipsis.
    const roomy = truncateText(input, 5);
    expect(roomy).toBe('ab👍…');
    expect(roomy.length).toBeLessThanOrEqual(5);
    expect(hasIsolatedSurrogate(roomy)).toBe(false);
  });

  it('drops a leading emoji when the budget cannot hold the pair plus ellipsis', () => {
    // Budget 2 → end=1 on high surrogate → back off → "…"
    expect(truncateText('👍rest', 2)).toBe('…');
    expect(hasIsolatedSurrogate(truncateText('👍rest', 2))).toBe(false);
    // Budget 3 → end=2 keeps the whole pair → "👍…"
    expect(truncateText('👍rest', 3)).toBe('👍…');
  });

  it('preserves normalizeWhitespace behavior', () => {
    expect(truncateText('  hello   world  ', 20, { normalizeWhitespace: true })).toBe(
      'hello world',
    );
    expect(truncateText('  hello   world  ', 8, { normalizeWhitespace: true })).toBe(
      'hello w…',
    );
    // Without the option, internal whitespace is left alone and short input preserved.
    expect(truncateText('  hi  ', 10)).toBe('  hi  ');
  });
});
