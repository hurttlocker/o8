/**
 * GitHub installation tokens live for one hour. Refresh at 50 minutes so the
 * license server's 15-minute replacement window mints a new token before the
 * broker's two-minute expiry guard makes the current token unavailable.
 */
export const MANAGED_GITHUB_REFRESH_INTERVAL_MS = 50 * 60 * 1000;

export function scheduleManagedGithubRefresh(refresh: () => void): () => void {
  const timer = setInterval(refresh, MANAGED_GITHUB_REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}
