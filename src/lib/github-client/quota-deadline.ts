const MAX_QUOTA_DELAY_MS = 24 * 60 * 60_000;
const DEFAULT_QUOTA_DELAY_MS = 60_000;

/** Only quota refusals defer reads; permission failures keep ordinary retry behavior. */
export function githubQuotaDeadline(response: Response): number | null {
  if (response.status !== 429 && response.status !== 403) return null;
  const now = Date.now();
  const retry = response.headers.get('retry-after');
  const seconds = Number(retry);
  const retryAt = Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : Date.parse(retry ?? '');
  if (response.status === 403 && !(retryAt > now) && response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const resetAt = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const deadline = Math.max(Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(resetAt) ? resetAt : 0);
  return Math.min(now + MAX_QUOTA_DELAY_MS, deadline > now ? deadline : now + DEFAULT_QUOTA_DELAY_MS);
}
