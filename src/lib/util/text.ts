export interface TruncateTextOptions {
  normalizeWhitespace?: boolean;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/**
 * Truncate to a nonnegative UTF-16 code-unit budget.
 *
 * Zero or negative budgets yield "". When truncation is required the result
 * includes a single ellipsis and never ends on an isolated high surrogate
 * (so emoji / astral plane characters at the cutoff stay intact or are
 * dropped as a whole pair).
 */
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

  if (maxChars <= 0) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  // Reserve one UTF-16 unit for the ellipsis.
  let end = Math.max(0, maxChars - 1);
  // Avoid splitting a surrogate pair: if the last kept unit is a high
  // surrogate, drop it so the pair stays whole (omitted) rather than
  // leaving an isolated surrogate in the truncated prefix.
  if (end > 0 && isHighSurrogate(normalized.charCodeAt(end - 1))) {
    end -= 1;
  }

  return `${normalized.slice(0, end).trimEnd()}…`;
}
// Multi-PR view test
