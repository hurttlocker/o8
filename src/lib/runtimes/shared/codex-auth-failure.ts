export const CODEX_AUTH_RECOVERY_MESSAGE = 'Codex sign-in expired on this machine. Run `codex login`, then reset and dispatch this packet again.';

/** Recognize a terminal Codex credential failure without exposing provider output. */
export function codexAuthRecoveryMessage(stderr: string): string | null {
  if (!/refresh_token_reused|failed to refresh token:\s*401|could not parse your authentication token/i.test(stderr)) {
    return null;
  }
  return CODEX_AUTH_RECOVERY_MESSAGE;
}
