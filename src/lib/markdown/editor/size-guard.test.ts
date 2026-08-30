import { describe, expect, it } from 'vitest';
import {
  RICH_MARKDOWN_MAX_SOURCE_BYTES,
  isMarkdownSourceOverRichThreshold,
  markdownSourceUtf8Bytes,
  richMarkdownSizeUnavailableReason,
} from './size-guard';

describe('markdown rich-mode size guard', () => {
  it('treats exactly the threshold as under (rich path allowed)', () => {
    const source = 'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES);
    expect(markdownSourceUtf8Bytes(source)).toBe(RICH_MARKDOWN_MAX_SOURCE_BYTES);
    expect(isMarkdownSourceOverRichThreshold(source)).toBe(false);
    expect(richMarkdownSizeUnavailableReason(source)).toBeNull();
  });

  it('treats one ASCII byte over the threshold as source-only', () => {
    const source = 'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES + 1);
    expect(isMarkdownSourceOverRichThreshold(source)).toBe(true);
    expect(richMarkdownSizeUnavailableReason(source)).toBe(
      `file is ${RICH_MARKDOWN_MAX_SOURCE_BYTES + 1} bytes (limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES})`,
    );
  });

  it('counts multibyte code points as UTF-8 bytes, not JS string length', () => {
    const source = `${'a'.repeat(RICH_MARKDOWN_MAX_SOURCE_BYTES - 1)}é`;
    expect(source.length).toBe(RICH_MARKDOWN_MAX_SOURCE_BYTES);
    expect(markdownSourceUtf8Bytes(source)).toBe(RICH_MARKDOWN_MAX_SOURCE_BYTES + 1);
    expect(isMarkdownSourceOverRichThreshold(source)).toBe(true);
  });
});
