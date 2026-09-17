/**
 * Phone Symon — the ONE prompt-injection filter for server-authored instruction text.
 *
 * Every free-text value the phone mint copies into the model instructions
 * (workspace-context display labels, and now the fleet briefing's approval
 * titles, lane titles, repository names and branch names) passes through
 * {@link safeDisplayLabel}. The label grammar keeps the value prompt-inert, and
 * {@link PROMPT_CONTROL_PATTERN} rejects instruction-override phrasing outright
 * rather than trying to neutralize it.
 *
 * Extracted from src/app/api/mobile/symon/session/route.ts so the briefing and
 * the workspace-context block cannot drift onto two different filters.
 */

export const DISPLAY_LABEL_PATTERN = /^[A-Za-z0-9 .,_@+()/#&':-]+$/;

export const PROMPT_CONTROL_PATTERN =
  /(?:ignore|disregard|override|reveal|repeat|follow)\b.{0,32}\b(?:instructions?|prompt|system|developer|assistant)|(?:system|developer|assistant)\s*:/i;

/** A bounded, prompt-inert display label, or undefined when the value cannot be trusted. */
export function safeDisplayLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  if (!label || label.length > maxLength || !DISPLAY_LABEL_PATTERN.test(label)) return undefined;
  return PROMPT_CONTROL_PATTERN.test(label) ? undefined : label;
}
