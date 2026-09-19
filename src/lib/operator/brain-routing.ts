import 'server-only';

import { resolveCodexReasoningEffort } from '@/lib/codex/reasoning-effort';
import { getEntitlementSync } from '@/lib/entitlement/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getOperatorDefaultsSync } from './defaults';

export type EffectiveBrainRoute = 'managed' | 'subscription' | 'legacy';

/**
 * Resolve the Brain's payer at the one shared boundary. An entitled plan in
 * auto mode uses only the managed route. Connected CLIs are intentionally
 * reachable only after the operator selects subscription mode.
 */
export function resolveEffectiveBrainRouteSync(): EffectiveBrainRoute {
  const values = getOperatorDefaultsSync().values;
  if (values.brainRoutingMode === 'subscription') return 'subscription';
  try {
    return getEntitlementSync().flags['proxy.inference'] === true ? 'managed' : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** Cache identity includes the policy and entitlement state, never a token. */
export function brainRouteCacheKeySync(): string {
  return resolveEffectiveBrainRouteSync();
}

export function usesManagedBrainInferenceSync(): boolean {
  return resolveEffectiveBrainRouteSync() === 'managed';
}

/** Whether the configured subscription profile permits Claude Brain calls. */
export function resolveBrainUseClaudeCliSync(): boolean {
  const values = getOperatorDefaultsSync().values;
  return resolveEffectiveBrainRouteSync() !== 'managed'
    && values.subscriptionProfile !== 'codex-only'
    && values.brainUseClaudeCli;
}

/**
 * Whether speculative Brain runtime warmup is allowed (#2521). Gates only the
 * speculative pre-spawn: an explicit ask still launches its selected runtime
 * when needed, and a managed-only route never reaches a subscription CLI
 * regardless of this value. Read synchronously at the warmup execution
 * boundary so a persisted flip applies without a restart, and re-read after
 * asynchronous discovery so no in-flight call site can bypass it.
 */
export function resolveBrainWarmupEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.brainWarmupEnabled;
}

/**
 * Live policy for speculative Brain warmup: the subscription CLI tier must be
 * permitted AND the operator must not have disabled warmup. The warm pool
 * consults this predicate at the exact refill moment, so a call queued behind
 * a turn observes a policy flip before it would pre-spawn a replacement.
 */
export function resolveBrainSpeculativeWarmupAllowedSync(): boolean {
  return resolveBrainUseClaudeCliSync() && resolveBrainWarmupEnabledSync();
}

/** Whether the configured subscription profile permits Codex Brain calls. */
export function resolveBrainUseCodexCliSync(): boolean {
  return resolveEffectiveBrainRouteSync() !== 'managed'
    && getOperatorDefaultsSync().values.subscriptionProfile !== 'claude-only';
}

export interface BrainCodexRoute {
  model: string;
  reasoningEffort?: Exclude<ThinkingEffort, 'adaptive'>;
}

/** Resolve the Brain-only Codex model and effort independently of worker defaults. */
export function resolveBrainCodexRouteSync(): BrainCodexRoute {
  const values = getOperatorDefaultsSync().values;
  const configuredEffort = values.brainCodexEffort === 'adaptive'
    ? values.codexWorkerEffort
    : values.brainCodexEffort;
  const reasoningEffort = configuredEffort === 'adaptive'
    ? undefined
    : resolveCodexReasoningEffort(configuredEffort, values.brainCodexModel) as BrainCodexRoute['reasoningEffort'];
  return {
    model: values.brainCodexModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
