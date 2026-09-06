import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/**
 * Codex reasoning-effort resolution — shared by the orchestrator session
 * (`reasoningEffortFromThinkingEffort`) and the worker launch surface
 * (`codexReasoningEffortArgs`) so the model gate lives in exactly one place.
 *
 * The flagship models expose two effort tiers above `xhigh`: `max` and `ultra`
 * (ultra = internal sub-agent fan-out, heavy token burn). Every other model
 * (terra, luna, gpt-5.5, gpt-5.4, locals) caps at `xhigh`.
 */

/** Only the Codex flagship models expose the `max` + `ultra` reasoning tiers. */
export function isCodexUltraCapableModel(model?: string | null): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('gpt-6-astra') || normalized.includes('gpt-5.6-sol');
}

/**
 * Map an app-level {@link ThinkingEffort} tier to the codex
 * `model_reasoning_effort` string for a given model. `effort` must be a concrete
 * tier (callers handle `adaptive`/undefined = runtime default separately).
 *
 * - `max` / `ultra` → passed through only on flagship models; otherwise clamped to
 *   `xhigh` (other models don't accept them).
 * - `low` / `medium` / `high` / `xhigh` → passed through verbatim.
 */
export function resolveCodexReasoningEffort(
  effort: Exclude<ThinkingEffort, 'adaptive'>,
  model?: string | null,
): string {
  if (effort === 'max' || effort === 'ultra') {
    return isCodexUltraCapableModel(model) ? effort : 'xhigh';
  }
  return effort;
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
