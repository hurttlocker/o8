export interface TruncateTextOptions {
  normalizeWhitespace?: boolean;
}

export function truncateText(
  value: string | null | undefined,
  maxChars: number,
  options: TruncateTextOptions = {},
): string {
  const normalized = options.normalizeWhitespace
    ? (value ?? '').replace(/\s+/g, ' ').trim()
    : (value ?? '');

  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
// PR density test
