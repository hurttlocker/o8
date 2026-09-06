import { describe, expect, it } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import {
  frontierEscalationModelForCheapTier,
  isCodexCheapTierModel,
  isCodexFrontierModel,
  isSingleSubCheapTierWorker,
  resolveSubscriptionProfileHouseDefaults,
  resolveSubscriptionProfileRouting,
} from './subscription-profile';

describe('subscription profile resolver', () => {
  it('leaves both-house routing untouched', () => {
    expect(resolveSubscriptionProfileHouseDefaults('both')).toBeNull();
    expect(resolveSubscriptionProfileRouting({
      profile: 'both',
      requestedRuntime: 'codex',
      requestedModel: null,
    })).toEqual({
      ok: true,
      requestedRuntime: 'codex',
      requestedModel: null,
    });
  });

  it('applies the configured worker model in both-house mode while preserving an explicit override', () => {
    expect(resolveSubscriptionProfileRouting({
      profile: 'both',
      requestedRuntime: 'codex',
      requestedModel: null,
      defaultDispatchModel: MODEL_IDS.raw.openAiGpt56Sol,
    })).toEqual({
      ok: true,
      requestedRuntime: 'codex',
      requestedModel: MODEL_IDS.raw.openAiGpt56Sol,
    });

    expect(resolveSubscriptionProfileRouting({
      profile: 'both',
      requestedRuntime: 'codex',
      requestedModel: MODEL_IDS.codexWorkerDefault,
      defaultDispatchModel: MODEL_IDS.raw.openAiGpt56Sol,
    })).toEqual({
      ok: true,
      requestedRuntime: 'codex',
      requestedModel: MODEL_IDS.codexWorkerDefault,
    });
  });

  it('pins Claude-only to Claude orchestration, workers, reviews, and Sonnet', () => {
    expect(resolveSubscriptionProfileHouseDefaults('claude-only')).toEqual({
      orchestratorBackend: 'claude',
      defaultDispatchRuntime: 'claude-code',
      defaultDispatchModel: MODEL_IDS.claudeWorkerDefault,
      reviewerBackend: 'claude',
    });
    expect(resolveSubscriptionProfileRouting({
      profile: 'claude-only',
      requestedRuntime: null,
      requestedModel: null,
    })).toEqual({
      ok: true,
      requestedRuntime: 'claude-code',
      requestedModel: MODEL_IDS.claudeWorkerDefault,
    });
  });

  it('pins Codex-only to Codex orchestration, Terra workers, reviews', () => {
    expect(resolveSubscriptionProfileHouseDefaults('codex-only')).toEqual({
      orchestratorBackend: 'codex',
      defaultDispatchRuntime: 'codex',
      defaultDispatchModel: MODEL_IDS.codexWorkerDefault,
      reviewerBackend: 'codex',
    });
    // The Codex worker default stays on Terra while Astra takes the orchestrator slot.
    expect(MODEL_IDS.codexWorkerDefault).toBe('gpt-5.6-terra');
    expect(MODEL_IDS.codexDefault).toBe('gpt-6-astra');
  });

  it('classifies codex frontier (Sol) vs cheap tiers (Terra/Luna)', () => {
    expect(isCodexFrontierModel('gpt-5.6-sol')).toBe(true);
    expect(isCodexFrontierModel('gpt-5.6-terra')).toBe(false);
    expect(isCodexCheapTierModel('gpt-5.6-terra')).toBe(true);
    expect(isCodexCheapTierModel('gpt-5.6-luna')).toBe(true);
    expect(isCodexCheapTierModel('gpt-5.6-sol')).toBe(false);
  });

  it('escalates a codex-only cheap-tier worker to Sol; frontier + both stay put', () => {
    // Terra worker under codex-only → cheap tier → escalates to Sol.
    expect(isSingleSubCheapTierWorker({ profile: 'codex-only', runtime: 'codex', model: MODEL_IDS.codexWorkerDefault })).toBe(true);
    expect(frontierEscalationModelForCheapTier({ profile: 'codex-only', runtime: 'codex', model: MODEL_IDS.codexWorkerDefault }))
      .toBe(MODEL_IDS.raw.openAiGpt56Sol);
    // A Sol worker is already frontier — no escalation.
    expect(isSingleSubCheapTierWorker({ profile: 'codex-only', runtime: 'codex', model: MODEL_IDS.raw.openAiGpt56Sol })).toBe(false);
    // Both-house never single-sub escalates.
    expect(frontierEscalationModelForCheapTier({ profile: 'both', runtime: 'codex', model: MODEL_IDS.codexWorkerDefault })).toBeNull();
    // Claude-only still escalates its cheap tier to Opus (unchanged).
    expect(frontierEscalationModelForCheapTier({ profile: 'claude-only', runtime: 'claude-code', model: MODEL_IDS.claudeWorkerDefault }))
      .toBe(MODEL_IDS.raw.anthropicClaudeOpus48);
  });

  it('returns a structured error for an unavailable explicit runtime', () => {
    expect(resolveSubscriptionProfileRouting({
      profile: 'claude-only',
      requestedRuntime: 'codex',
      requestedModel: null,
    })).toEqual({
      ok: false,
      code: 'subscription_profile_runtime_unavailable',
      message: 'subscriptionProfile "claude-only" only allows runtime "claude-code". Requested runtime "codex" is unavailable under this profile.',
    });
  });

  it('keeps explicitly selected provider runtimes available under a single-subscription profile', () => {
    expect(resolveSubscriptionProfileRouting({
      profile: 'codex-only',
      requestedRuntime: 'opencode',
      requestedModel: 'openrouter/deepseek/deepseek-v4-flash',
      defaultDispatchModel: MODEL_IDS.codexWorkerDefault,
    })).toEqual({
      ok: true,
      requestedRuntime: 'opencode',
      requestedModel: 'openrouter/deepseek/deepseek-v4-flash',
    });

    expect(resolveSubscriptionProfileRouting({
      profile: 'claude-only',
      requestedRuntime: 'opencode',
      requestedModel: null,
      defaultDispatchModel: MODEL_IDS.claudeWorkerDefault,
    })).toEqual({
      ok: true,
      requestedRuntime: 'opencode',
      requestedModel: null,
    });
  });

  it('keeps explicit in-house models and drops cross-house defaults', () => {
    expect(resolveSubscriptionProfileRouting({
      profile: 'claude-only',
      requestedRuntime: null,
      requestedModel: 'claude-opus-4-8',
      defaultDispatchModel: MODEL_IDS.raw.openAiGpt56Sol,
    })).toEqual({
      ok: true,
      requestedRuntime: 'claude-code',
      requestedModel: 'claude-opus-4-8',
    });

    expect(resolveSubscriptionProfileRouting({
      profile: 'claude-only',
      requestedRuntime: null,
      requestedModel: null,
      defaultDispatchModel: MODEL_IDS.raw.openAiGpt56Sol,
    })).toEqual({
      ok: true,
      requestedRuntime: 'claude-code',
      requestedModel: MODEL_IDS.claudeWorkerDefault,
    });
  });
});
