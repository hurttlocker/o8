import { safeText } from './state.js';

export interface InputValue { text: string; cursor: number }
type InputKey = Partial<Record<'ctrl' | 'meta' | 'leftArrow' | 'rightArrow' | 'upArrow' | 'downArrow' | 'home' | 'end' | 'backspace' | 'delete' | 'return', boolean>>;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

/** Cursor offsets are graphemes so emoji and combining marks remain intact. */
export function editInput(value: InputValue, input: string, key: InputKey): InputValue {
  const chars = graphemes(value.text);
  let cursor = Math.min(value.cursor, chars.length);
  if (key.leftArrow) cursor = Math.max(0, cursor - 1);
  else if (key.rightArrow) cursor = Math.min(chars.length, cursor + 1);
  else if (key.upArrow || key.downArrow) {
    const lineStart = chars.lastIndexOf('\n', cursor - 1) + 1;
    const lineEndIndex = chars.indexOf('\n', cursor);
    const lineEnd = lineEndIndex < 0 ? chars.length : lineEndIndex;
    const column = cursor - lineStart;
    if (key.upArrow && lineStart > 0) {
      const previousStart = chars.lastIndexOf('\n', lineStart - 2) + 1;
      cursor = Math.min(lineStart - 1, previousStart + column);
    } else if (key.downArrow && lineEnd < chars.length) {
      const nextEnd = chars.indexOf('\n', lineEnd + 1);
      cursor = Math.min(nextEnd < 0 ? chars.length : nextEnd, lineEnd + 1 + column);
    }
  } else if (key.home || (key.ctrl && input === 'a')) {
    while (cursor > 0 && chars[cursor - 1] !== '\n') cursor -= 1;
  } else if (key.end || (key.ctrl && input === 'e')) {
    while (cursor < chars.length && chars[cursor] !== '\n') cursor += 1;
  } else if (key.backspace) {
    if (cursor > 0) chars.splice(--cursor, 1);
  } else if (key.delete) chars.splice(cursor, 1);
  else if (key.ctrl && input === 'u') {
    chars.splice(0, cursor);
    cursor = 0;
  } else if (key.ctrl && input === 'k') chars.splice(cursor);
  else if (key.ctrl && input === 'w') {
    const end = cursor;
    while (cursor > 0 && /\s/.test(chars[cursor - 1]!)) cursor -= 1;
    while (cursor > 0 && !/\s/.test(chars[cursor - 1]!)) cursor -= 1;
    chars.splice(cursor, end - cursor);
  } else if (key.ctrl && input === 'j') chars.splice(cursor++, 0, '\n');
  else if (!key.ctrl && !key.meta && input) {
    const inserted = graphemes(safeText(input.replace(/\r\n?/g, '\n')));
    chars.splice(cursor, 0, ...inserted);
    cursor += inserted.length;
  }
  return { text: chars.join(''), cursor };
}
