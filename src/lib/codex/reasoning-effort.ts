import type { ManualThinkingEffort, ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/**
 * Codex reasoning-effort resolution — shared by the orchestrator session
 * (`reasoningEffortFromThinkingEffort`) and the worker launch surface
 * (`codexReasoningEffortArgs`) so the model gate lives in exactly one place.
 *
 * High-end effort is an installed-catalog capability, not a model-name rule.
 * Keep this serializable module client-safe: the desktop picker and server
 * admission both consume the same verified pairs.
 */

const HIGH_END_EFFORTS = ['max', 'ultra'] as const satisfies readonly ManualThinkingEffort[];

/**
 * Verified Codex CLI catalog captured from the installed 0.153.4 runtime on
 * 2026-09-19. This is intentionally exact-match evidence: do not infer support
 * from a provider prefix, a future model name, or a version alone.
 */
export const CODEX_HIGH_END_EFFORT_CATALOG: Readonly<Record<string, readonly ManualThinkingEffort[]>> = Object.freeze({
  'gpt-6-astra': HIGH_END_EFFORTS,
  'gpt-5.6-sol': HIGH_END_EFFORTS,
  'gpt-5.6-terra': HIGH_END_EFFORTS,
});

export function codexSupportsReasoningEffort(
  model: string | null | undefined,
  effort: ManualThinkingEffort,
): boolean {
  if (!HIGH_END_EFFORTS.includes(effort as typeof HIGH_END_EFFORTS[number])) return true;
  const normalized = model?.trim().toLowerCase();
  return Boolean(normalized && CODEX_HIGH_END_EFFORT_CATALOG[normalized]?.includes(effort));
}

/** Whether the verified catalog lists the `ultra` effort tier for this model. */
export function isCodexUltraCapableModel(model?: string | null): boolean {
  return codexSupportsReasoningEffort(model, 'ultra');
}

/**
 * Map an app-level {@link ThinkingEffort} tier to the codex
 * `model_reasoning_effort` string for a given model. `effort` must be a concrete
 * tier (callers handle `adaptive`/undefined = runtime default separately).
 *
 * - `max` / `ultra` → passed through only for exact verified catalog pairs;
 *   unknown pairs clamp to `xhigh`.
 * - `low` / `medium` / `high` / `xhigh` → passed through verbatim.
 */
export function resolveCodexReasoningEffort(
  effort: Exclude<ThinkingEffort, 'adaptive'>,
  model?: string | null,
): string {
  return codexSupportsReasoningEffort(model, effort) ? effort : 'xhigh';
}

/**
 * Whether the INSTALLED codex CLI understands the `max`/`ultra` reasoning
 * tiers. They landed in codex-cli 0.144.x — 0.136.0 refuses to even load a
 * config that mentions them (`unknown variant \`max\``) and the whole spawn
 * dies exit-1 before the first token (#1551 walkdown, live-hit 2026-07-12 on
 * an older laptop install). Unknown/unparseable version → false: xhigh is
 * accepted by every codex we ship against, so clamping is always safe.
 */
export function codexCliSupportsUltraEfforts(version?: string | null): boolean {
  const m = version?.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 144;
}
