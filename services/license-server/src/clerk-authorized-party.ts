/**
 * Clerk only adds `azp` when a session token was minted for a browser origin.
 * Native clients use an Authorization header with no Origin, so their signed
 * session tokens legitimately omit the claim. Clerk's verification guidance
 * says to skip the authorized-party comparison when the claim is absent.
 *
 * A present claim still has to be a non-empty exact allowlist match. This keeps
 * browser tokens fail-closed when the production allowlist is missing or stale.
 */
export function isAuthorizedClerkParty(
  azp: unknown,
  authorizedParties: readonly string[],
): boolean {
  if (azp === undefined) return true;
  return typeof azp === 'string' && azp.length > 0 && authorizedParties.includes(azp);
}
