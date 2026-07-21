/**
 * The desktop refreshes managed GitHub credentials every 50 minutes. Mint a
 * replacement once a cached one has 15 minutes left so that refresh always
 * receives a token with a fresh one-hour window instead of the nearly-expired
 * token it was trying to replace.
 */
export const INSTALLATION_TOKEN_REFRESH_SKEW_MS = 15 * 60 * 1000;

export function isInstallationTokenReusable(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs)
    && expiresAtMs - nowMs > INSTALLATION_TOKEN_REFRESH_SKEW_MS;
}
