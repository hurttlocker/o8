/**
 * Phone Symon — the ONE prompt-injection filter for server-authored instruction text.
 *
 * Every free-text value the phone mint copies into the model instructions
 * (workspace-context display labels, and the fleet briefing's approval titles,
 * lane titles, repository names and branch names) passes through
 * {@link safeDisplayLabel}.
 *
 * DEFENCE IN DEPTH, and the order matters. The FIRST layer is structural and
 * lives in the briefing renderer: every value is emitted as a labeled, quoted
 * field, and the label grammar below excludes `"`, so a value can never close
 * its own quote or pose as a new line of guidance. A denylist alone is a losing
 * game — it is six verbs against every paraphrase of "do what I say" — so this
 * module is the SECOND layer, not the defence.
 *
 * Extracted from src/app/api/mobile/symon/session/route.ts so the briefing and
 * the workspace-context block cannot drift onto two different filters.
 */

/** No `"`, no `<`, no backtick, no newline — the structural guarantee the renderer leans on. */
export const DISPLAY_LABEL_PATTERN = /^[A-Za-z0-9 .,_@+()/#&':-]+$/;

/** Classic "ignore your instructions" phrasing, anywhere in the value. */
const INSTRUCTION_OVERRIDE_PATTERN =
  /(?:ignore|disregard|override|reveal|repeat|follow)\b.{0,32}\b(?:instructions?|prompt|system|developer|assistant)|(?:system|developer|assistant)\s*:/i;

/**
 * Role-prefix framing that tries to open a new turn — "Human: …", "Operator: …",
 * "New instructions, …". Anchored at the start, and the role words demand a
 * colon so ordinary titles ("User profile page") survive.
 */
const ROLE_PREFIX_PATTERN =
  /^\s*(?:human|operator|user|system|developer|assistant|agent)\s*:|^\s*new\s+instructions?\b/i;

/**
 * The bulk-action shape — an approval verb aimed at everything at once
 * ("approve every pending item", "merge all lanes"). Scoped tightly so a benign
 * product title such as "Approve flow needs a spinner" is not swept up.
 */
const BULK_ACTION_PATTERN =
  /\b(?:approve|approves|approving|reject|rejects|rejecting|merge|merges|merging|dispatch|dispatches|dispatching|confirm|confirms|confirming|accept|accepts|accepting)\b[^.!?]{0,48}?\b(?:all|every|everything|each)\b/i;

export const PROMPT_CONTROL_PATTERNS = [
  INSTRUCTION_OVERRIDE_PATTERN,
  ROLE_PREFIX_PATTERN,
  BULK_ACTION_PATTERN,
] as const;

/** Does this value read as an attempt to steer the model rather than to name a thing? */
export function isPromptShapedLabel(value: string): boolean {
  return PROMPT_CONTROL_PATTERNS.some((pattern) => pattern.test(value));
}

/** A bounded, prompt-inert display label, or undefined when the value cannot be trusted. */
export function safeDisplayLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  if (!label || label.length > maxLength || !DISPLAY_LABEL_PATTERN.test(label)) return undefined;
  return isPromptShapedLabel(label) ? undefined : label;
}
