// 'ultra' is a Codex flagship reasoning tier (internal sub-agent fan-out, heavy
// token burn). It is a valid app effort but is clamped to 'xhigh' by the Codex
// effort resolver for other models, and mapped down for Claude.
export type ThinkingEffort = 'adaptive' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'ultra';

export type ManualThinkingEffort = Exclude<ThinkingEffort, 'adaptive'>;

export const THINKING_EFFORTS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'];
export const MANUAL_THINKING_EFFORTS: ManualThinkingEffort[] = ['low', 'medium', 'high', 'max', 'xhigh', 'ultra'];

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && THINKING_EFFORTS.includes(value as ThinkingEffort);
}

export function isManualThinkingEffort(value: unknown): value is ManualThinkingEffort {
  return typeof value === 'string' && MANUAL_THINKING_EFFORTS.includes(value as ManualThinkingEffort);
}

/**
 * Value for the Claude CLI `--effort` flag. Claude has no `ultra` tier (that's a
 * Codex flagship reasoning level), so a stale `ultra` selection carried
 * onto a Claude turn maps down to `max`. Every other tier passes through
 * byte-identically.
 */
export function claudeEffortFlagValue(effort: string): string {
  return effort === 'ultra' ? 'max' : effort;
}
