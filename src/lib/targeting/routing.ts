/**
 * Targeting Machine — difficulty → tier routing (requirement 2).
 *
 * The scorer says WHERE to aim; this says WITH WHAT. A deliberately dumb,
 * hardcoded table maps a file's difficulty to a tier, and the tier resolves to a
 * runtime/model/effort from the operator's config (step 4). The Dispatch action
 * passes that runtime/model as requestedRuntime/requestedModel, which flow
 * through `resolveWorkerRouting` unchanged — so this table + the existing
 * passthrough IS the "don't burn a frontier model at max effort on a one-line
 * rename" savings.
 */

import { getOperatorDefaultsSync, resolveTargetingActionSync, resolveTargetingTriageSync, type TargetingTier } from '@/lib/operator/defaults';
import { createRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { TargetSignals } from './signals';

export type TargetingTierName = 'triage' | 'action';

/**
 * v1 difficulty → tier: a SMALL, LOW-CHURN file is cheap, bounded work → the
 * cheap triage tier; everything else (big, central, or actively churning) earns
 * the premium action tier. Pure + hardcoded — no learning, no config knob.
 */
export function pickTier(signals: TargetSignals): TargetingTierName {
  const small = signals.loc < 150;
  const lowChurn = signals.churn < 3;
  return small && lowChurn ? 'triage' : 'action';
}

export interface TargetingRouting {
  tier: TargetingTierName;
  runtime: OrchestratorRuntime;
  /** '' = the runtime's default model. */
  model: string;
  effort: ThinkingEffort;
}

/**
 * Resolve the full dispatch routing for a file: pick the tier, then read that
 * tier's configured runtime/model/effort. (Effort is config-resolved for future
 * use; the create-mission passthrough carries runtime + model today, per the
 * resolveWorkerRouting contract.)
 */
export function resolveTargetingRouting(
  signals: TargetSignals,
  receiptContext?: { repoPath: string; contextId: string },
): TargetingRouting {
  const tier = pickTier(signals);
  const cfg: TargetingTier = tier === 'triage' ? resolveTargetingTriageSync() : resolveTargetingActionSync();
  if (receiptContext) {
    const defaults = getOperatorDefaultsSync();
    const source = tier === 'triage' ? defaults.sources.targetingTriage : defaults.sources.targetingAction;
    const configuredModel = cfg.model.trim() || null;
    const effectiveModel = configuredModel ?? getRuntimeCapability(cfg.runtime).defaultModel ?? null;
    recordRoleRoutingReceiptSafely({
      role: 'triage',
      repoPath: receiptContext.repoPath,
      contextType: 'targeting-file',
      contextId: receiptContext.contextId,
      requested: createRoleRouteChoice({
        backend: null,
        runtime: cfg.runtime,
        model: configuredModel,
        effort: cfg.effort,
      }),
      effective: createRoleRouteChoice({
        backend: null,
        runtime: cfg.runtime,
        model: effectiveModel,
        effort: cfg.effort,
      }),
      sources: {
        backend: 'derived',
        runtime: source,
        model: configuredModel ? source : 'runtime-default',
        effort: source,
      },
      reason: `Deterministic targeting signals selected the ${tier} tier; the operator-owned ${tier} route supplied its runtime, model, and effort.`,
      status: 'selected',
    });
  }
  return { tier, runtime: cfg.runtime, model: cfg.model, effort: cfg.effort };
}
