import { describe, expect, it } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import {
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

  it('pins Codex-only to Codex orchestration, workers, reviews, and GPT-5.5', () => {
    expect(resolveSubscriptionProfileHouseDefaults('codex-only')).toEqual({
      orchestratorBackend: 'codex',
      defaultDispatchRuntime: 'codex',
      defaultDispatchModel: MODEL_IDS.codexDefault,
      reviewerBackend: 'codex',
    });
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
});
