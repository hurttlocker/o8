import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { isDispatchRuntime } from './defaults-env';

/**
 * Targeting Machine tier — which CLI / model / effort to use for a role. The
 * Targeting Machine has two symmetric triads: `targetingTriage` (the cheap
 * scorer/rationale tier, default low effort) and `targetingAction` (the premium
 * "point a real agent here" tier, default high effort). Each subfield is
 * env-overridable through the matching `O8_TRIAGE_*` / `O8_ACTION_*` variable.
 */
export interface TargetingTier {
  runtime: OrchestratorRuntime;
  /** Model id; an empty string selects the runtime default. */
  model: string;
  effort: ThinkingEffort;
}

export function isTargetingTier(value: unknown): value is TargetingTier {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isDispatchRuntime(candidate.runtime)
    && typeof candidate.model === 'string'
    && isThinkingEffort(candidate.effort);
}

export function coerceStoredTier(
  raw: unknown,
  fallback: TargetingTier,
): TargetingTier | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;
  return {
    runtime: isDispatchRuntime(candidate.runtime) ? candidate.runtime : fallback.runtime,
    model: typeof candidate.model === 'string' ? candidate.model : fallback.model,
    effort: isThinkingEffort(candidate.effort) ? candidate.effort : fallback.effort,
  };
}

/** Read the env overrides for one tier, returning only explicitly set fields. */
export function envTargetingTier(prefix: 'TRIAGE' | 'ACTION'): Partial<TargetingTier> | null {
  const result: Partial<TargetingTier> = {};
  const runtime = process.env[`O8_${prefix}_RUNTIME`]?.trim();
  if (runtime && isDispatchRuntime(runtime)) result.runtime = runtime;
  const model = process.env[`O8_${prefix}_MODEL`];
  if (typeof model === 'string') result.model = model.trim();
  const effort = process.env[`O8_${prefix}_EFFORT`]?.trim();
  if (effort && isThinkingEffort(effort)) result.effort = effort;
  return Object.keys(result).length > 0 ? result : null;
}

/** Merge env over persisted values over fallback, subfield by subfield. */
export function mergeTier(
  env: Partial<TargetingTier> | null,
  file: TargetingTier | undefined,
  fallback: TargetingTier,
): TargetingTier {
  return {
    runtime: env?.runtime ?? file?.runtime ?? fallback.runtime,
    model: env?.model ?? file?.model ?? fallback.model,
    effort: env?.effort ?? file?.effort ?? fallback.effort,
  };
}
