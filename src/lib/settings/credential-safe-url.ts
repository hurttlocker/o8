const CREDENTIAL_QUERY_PARAM = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|credential|jwt|key|pass(?:word|wd)?|secret|sig(?:nature)?|token)(?:$|[_-])/i;

export const AUTHENTICATED_ENDPOINT_GUIDANCE = 'use an environment variable or keychain for authenticated endpoints';

export function credentialBearingUrlPart(value: string): 'userinfo' | 'query parameter' | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'userinfo';
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_PARAM.test(key)) return 'query parameter';
    }
  } catch {
    // Existing endpoint settings allow non-URL strings. This validator is
    // deliberately scoped to preventing credential disclosure in settings.toml.
  }
  return null;
}

export function validateCredentialSafeUrl(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  const trimmed = value.trim();
  const part = credentialBearingUrlPart(trimmed);
  if (part) {
    throw new Error(`${key} must not contain credential-bearing URL ${part}; ${AUTHENTICATED_ENDPOINT_GUIDANCE}.`);
  }
  return trimmed;
}
