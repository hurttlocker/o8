export interface ReviewerPrSource { pullRequest: number; headSha: string }

export function normalizeReviewerPrSource(value: unknown): ReviewerPrSource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  return typeof source.pullRequest === 'number' && Number.isSafeInteger(source.pullRequest) && source.pullRequest > 0
    && typeof source.headSha === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.headSha)
    ? { pullRequest: source.pullRequest, headSha: source.headSha } : undefined;
}
