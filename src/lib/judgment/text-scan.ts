/**
 * Hidden-text scan for judgment state (#2434).
 *
 * Flags characters that make a diff read differently to a model than to a
 * person: zero-width characters, bidi controls, words that mix Latin with
 * Cyrillic or Greek letters, and files that mix CRLF with LF line endings.
 * `normalizeForJudgment` returns the copy that is sent: line endings as LF,
 * unicode spaces as plain spaces, trailing whitespace removed, and every
 * invisible control shown as a visible `<U+XXXX>` marker. This is defense in
 * depth: in the adversarial run hidden changes were still scored as risky.
 */

export interface TextScanFlags {
  zeroWidth: boolean;
  bidiControl: boolean;
  mixedScript: boolean;
  crlfMixed: boolean;
}

const ZERO_WIDTH = /[​‌‍⁠﻿᠎]/;
const BIDI_CONTROL = /[‎‏؜‪-‮⁦-⁩]/;
const INVISIBLE = /[​‌‍⁠﻿᠎‎‏؜‪-‮⁦-⁩]/g;
const UNICODE_SPACE = /[   -   　]/g;
const LATIN = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

function hasMixedScriptWord(text: string): boolean {
  for (const word of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
    if (LATIN.test(word) && CONFUSABLE_SCRIPT.test(word)) return true;
  }
  return false;
}

export function scanText(text: string): TextScanFlags {
  const crlf = /\r\n/.test(text);
  const bareLf = /(?:^|[^\r])\n/.test(text);
  return {
    zeroWidth: ZERO_WIDTH.test(text),
    bidiControl: BIDI_CONTROL.test(text),
    mixedScript: hasMixedScriptWord(text),
    crlfMixed: crlf && bareLf,
  };
}

export const anyTextFlag = (flags: TextScanFlags) =>
  flags.zeroWidth || flags.bidiControl || flags.mixedScript || flags.crlfMixed;

/** The text with invisible controls removed, for pattern checks that must not be split by them. */
export const stripInvisible = (text: string) => text.replace(INVISIBLE, '');

export function normalizeForJudgment(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`)
    .replace(UNICODE_SPACE, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}
