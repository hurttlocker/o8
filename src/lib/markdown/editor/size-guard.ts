/**
 * Rich Markdown (ProseMirror) is skipped above this UTF-8 byte size.
 * Equality is allowed: `bytes > RICH_MARKDOWN_MAX_SOURCE_BYTES` is source-only.
 * Measured with TextEncoder so multibyte code points cannot sneak under a
 * JavaScript string-length check.
 */
export const RICH_MARKDOWN_MAX_SOURCE_BYTES = 64 * 1024;

const utf8 = new TextEncoder();

export function markdownSourceUtf8Bytes(source: string): number {
  return utf8.encode(source).byteLength;
}

export function isMarkdownSourceOverRichThreshold(source: string): boolean {
  return markdownSourceUtf8Bytes(source) > RICH_MARKDOWN_MAX_SOURCE_BYTES;
}

export function richMarkdownSizeUnavailableReason(source: string): string | null {
  const bytes = markdownSourceUtf8Bytes(source);
  if (bytes <= RICH_MARKDOWN_MAX_SOURCE_BYTES) return null;
  return `file is ${bytes} bytes (limit ${RICH_MARKDOWN_MAX_SOURCE_BYTES})`;
}
