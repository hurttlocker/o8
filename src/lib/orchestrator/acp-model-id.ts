/**
 * Shape validation for a discovered ACP model id.
 *
 * These ids CANNOT be checked against a fixed list the way `orchestratorModel`
 * is: they come from whatever providers the operator's agent is authenticated
 * for (864 on this machine, a different set on the next). Pinning a list here
 * would go stale the day a provider ships a model.
 *
 * So this is a shape gate, not an allowlist, and it is deliberately the WEAKER
 * of two defenses. The strong one is that the picker only ever offers ids the
 * agent itself reported — which matters because `session/set_model` accepts an
 * unknown id silently and then produces an empty turn. This exists to stop a
 * hand-edited settings file or a malformed API call from persisting something
 * that could never work, not to certify that a model exists.
 */

/** Longest plausible provider/model[/effort] id; well clear of real ones. */
const MAX_LENGTH = 200;

/**
 * Whether a string is shaped like a model id an ACP agent could accept:
 * slash-separated non-empty segments of URL-safe characters, no whitespace.
 */
export function isPlausibleAcpModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return false;
  if (trimmed !== value.trim()) return false;
  // No leading/trailing slash, and no empty interior segment ("a//b").
  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return false;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0)) return false;
  // Letters, digits, and the punctuation real ids use: . _ - : and @.
  return segments.every((segment) => /^[A-Za-z0-9._:@~-]+$/.test(segment));
}

/** Normalize for storage, or null when the value isn't a usable id. */
export function normalizeAcpModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPlausibleAcpModelId(trimmed) ? trimmed : null;
}
