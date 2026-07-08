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

export function isSubscriptionProfile(value: unknown): value is SubscriptionProfile {
  return value === 'both' || value === 'claude-only' || value === 'codex-only';
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
      defaultDispatchModel: MODEL_IDS.codexDefault,
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

function modelAllowedForProfile(profile: SubscriptionProfile, model: string): boolean {
  const house = modelHouse(model);
  if (!house || profile === 'both') return true;
  return profile === 'claude-only' ? house === 'claude' : house === 'codex';
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
  const house = resolveSubscriptionProfileHouseDefaults(input.profile);
  if (!house) {
    return {
      ok: true,
      requestedRuntime: input.requestedRuntime ?? null,
      requestedModel: input.requestedModel?.trim() || null,
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
