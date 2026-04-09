const compactTokenFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Formats a token count into a compact human-readable label such as `1.5K` or `1.5M`.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) {
    return '0';
  }

  return compactTokenFormatter.format(n);
}
