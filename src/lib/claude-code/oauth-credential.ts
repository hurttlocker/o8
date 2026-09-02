/**
 * Shape check for a live Claude OAuth credential blob.
 *
 * Shared by the worker credential-seeding path (codex-subscription-proxy) and the
 * runtime readiness path (claude-login-probe) so both agree on what counts as a
 * credential. An empty or whitespace-only token field is a logged-out remnant, not
 * a credential — Claude Code leaves those behind after a sign-out.
 *
 * Never logs, echoes, or returns any part of `raw`.
 */

function isLiveToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function hasLiveClaudeOAuth(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) return false;
    const record = oauth as Record<string, unknown>;
    return isLiveToken(record.accessToken) || isLiveToken(record.refreshToken);
  } catch {
    return false;
  }
}
