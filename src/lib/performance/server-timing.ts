export function totalServerTiming(startedAt: number): string {
  return `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`;
}

export function serverTimingHeaders(
  startedAt: number,
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    'Server-Timing': totalServerTiming(startedAt),
  };
}
