import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { OrchestratorBackendSetting, ReviewerBackendSetting } from './defaults';

export type SubscriptionProfile = 'both' | 'claude-only' | 'codex-only';

export interface SubscriptionProfileHouseDefaults {
  orchestratorBackend: OrchestratorBackendSetting;
  defaultDispatchRuntime: OrchestratorRuntime;
  defaultDispatchModel: string | null;
  reviewerBackend: ReviewerBackendSetting;
}

export interface ResolveSubscriptionProfileInput {
  profile: SubscriptionProfile;
  requestedRuntime?: OrchestratorRuntime | null;
  requestedModel?: string | null;
  defaultDispatchModel?: string | null;
}

export interface SubscriptionProfileRoutingResult {
  ok: true;
  requestedRuntime: OrchestratorRuntime | null;
  requestedModel: string | null;
}

export interface SubscriptionProfileRoutingError {
  ok: false;
  code: 'subscription_profile_runtime_unavailable';
  message: string;
}

export interface CheapTierWorkerInput {
  profile: SubscriptionProfile;
  runtime?: OrchestratorRuntime | null;
  model?: string | null;
}

export function isSubscriptionProfile(value: unknown): value is SubscriptionProfile {
  return value === 'both' || value === 'claude-only' || value === 'codex-only';
}

export function isSingleSubscriptionProfile(profile: SubscriptionProfile): boolean {
  return profile !== 'both';
}

export function resolveSubscriptionProfileHouseDefaults(profile: SubscriptionProfile): SubscriptionProfileHouseDefaults | null {
  if (profile === 'claude-only') {
    return {
      orchestratorBackend: 'claude',
      defaultDispatchRuntime: 'claude-code',
      defaultDispatchModel: MODEL_IDS.claudeWorkerDefault,
      reviewerBackend: 'claude',
    };
  }
  if (profile === 'codex-only') {
    return {
      orchestratorBackend: 'codex',
      defaultDispatchRuntime: 'codex',
      // Codex-only workers ride the cheaper Terra tier; the orchestrator runs Sol
      // (gpt-5.6-sol via resolveOrchestratorModelSync). Cheap→Sol escalation is
      // wired below in frontierEscalationModelForCheapTier.
      defaultDispatchModel: MODEL_IDS.codexWorkerDefault,
      reviewerBackend: 'codex',
    };
  }
  return null;
}

function modelHouse(model: string): 'claude' | 'codex' | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('claude-') || normalized.includes('/claude-')) return 'claude';
  if (normalized.startsWith('gpt-') || normalized.startsWith('openai-') || normalized.includes('/gpt-')) return 'codex';
  return null;
}

function isClaudeFrontierModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('opus-4-8') || normalized.includes('opus-4-7') || normalized.includes('opus[1m]');
}

function isClaudeCheapTierModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('sonnet') || normalized.includes('haiku') || normalized.includes('opus-4-6');
}

/** Codex frontier tier — gpt-5.6-sol (Opus-class), the escalation target. */
export function isCodexFrontierModel(model: string): boolean {
  return model.trim().toLowerCase().includes('gpt-5.6-sol');
}

/** Codex cheap tier — gpt-5.6-terra / gpt-5.6-luna (Sonnet/Haiku-class). */
export function isCodexCheapTierModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.includes('gpt-5.6-terra') || normalized.includes('gpt-5.6-luna');
}

export function isSingleSubCheapTierWorker(input: CheapTierWorkerInput): boolean {
  if (!isSingleSubscriptionProfile(input.profile)) return false;
  if (input.profile === 'claude-only' && input.runtime === 'claude-code') {
    const model = input.model?.trim() || MODEL_IDS.claudeWorkerDefault;
    if (isClaudeFrontierModel(model)) return false;
    return isClaudeCheapTierModel(model);
  }
  if (input.profile === 'codex-only' && input.runtime === 'codex') {
    const model = input.model?.trim() || MODEL_IDS.codexWorkerDefault;
    if (isCodexFrontierModel(model)) return false;
    return isCodexCheapTierModel(model);
  }
  return false;
}

export function frontierEscalationModelForCheapTier(input: CheapTierWorkerInput): string | null {
  if (!isSingleSubCheapTierWorker(input)) return null;
  return input.profile === 'codex-only'
    ? MODEL_IDS.raw.openAiGpt56Sol
    : MODEL_IDS.raw.anthropicClaudeOpus48;
}

function modelAllowedForProfile(profile: SubscriptionProfile, model: string): boolean {
  const house = modelHouse(model);
  if (!house || profile === 'both') return true;
  return profile === 'claude-only' ? house === 'claude' : house === 'codex';
}

function subscriptionRuntimeHouse(runtime: OrchestratorRuntime): 'claude' | 'codex' | null {
  if (runtime === 'claude-code') return 'claude';
  if (runtime === 'codex') return 'codex';
  return null;
}

/**
 * A model id is usable for a target runtime house when either side is
 * unclassifiable (an id we can't attribute to a house, or a runtime without
 * one), or both houses agree. Guards against a stale/mismatched
 * `defaultDispatchModel` (e.g. a Codex model id left over from before the
 * operator's `defaultDispatchRuntime` was switched to claude-code) leaking
 * straight into a different house's spawn argv.
 */
function modelCompatibleWithRuntimeHouse(
  model: string,
  runtimeHouse: 'claude' | 'codex' | null,
): boolean {
  if (!runtimeHouse) return true;
  const house = modelHouse(model);
  return !house || house === runtimeHouse;
}

function effectiveProfileModel(input: ResolveSubscriptionProfileInput, fallbackModel: string | null): string | null {
  const requested = input.requestedModel?.trim();
  if (requested && modelAllowedForProfile(input.profile, requested)) return requested;
  const storedDefault = input.defaultDispatchModel?.trim();
  if (storedDefault && modelAllowedForProfile(input.profile, storedDefault)) return storedDefault;
  return fallbackModel;
}

export function resolveSubscriptionProfileRouting(
  input: ResolveSubscriptionProfileInput,
): SubscriptionProfileRoutingResult | SubscriptionProfileRoutingError {
  const requestedRuntimeHouse = input.requestedRuntime
    ? subscriptionRuntimeHouse(input.requestedRuntime)
    : null;
  // Subscription profiles describe which account-backed CLI house o8 may
  // spend against. Third-party and BYOK runtimes own their authentication and
  // billing, so an explicit OpenCode, local, or provider runtime remains
  // available under either single-subscription profile. Do not leak the
  // account house's default model into that runtime; its adapter resolves its
  // own saved/default model when the caller did not pin one.
  if (input.requestedRuntime && !requestedRuntimeHouse) {
    return {
      ok: true,
      requestedRuntime: input.requestedRuntime,
      requestedModel: input.requestedModel?.trim() || null,
    };
  }

  const house = resolveSubscriptionProfileHouseDefaults(input.profile);
  if (!house) {
    const requestedModel = input.requestedModel?.trim() || null;
    const storedDefault = input.defaultDispatchModel?.trim() || null;
    const resolvedModel = requestedModel && modelCompatibleWithRuntimeHouse(requestedModel, requestedRuntimeHouse)
      ? requestedModel
      : storedDefault && modelCompatibleWithRuntimeHouse(storedDefault, requestedRuntimeHouse)
        ? storedDefault
        : null;
    return {
      ok: true,
      requestedRuntime: input.requestedRuntime ?? null,
      requestedModel: resolvedModel,
    };
  }

  if (input.requestedRuntime && input.requestedRuntime !== house.defaultDispatchRuntime) {
    return {
      ok: false,
      code: 'subscription_profile_runtime_unavailable',
      message: `subscriptionProfile "${input.profile}" only allows runtime "${house.defaultDispatchRuntime}". Requested runtime "${input.requestedRuntime}" is unavailable under this profile.`,
    };
  }

  return {
    ok: true,
    requestedRuntime: house.defaultDispatchRuntime,
    requestedModel: effectiveProfileModel(input, house.defaultDispatchModel),
  };
}
