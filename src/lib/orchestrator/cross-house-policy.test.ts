import { describe, expect, it } from 'vitest';
import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import {
  CROSS_HOUSE_EQUIVALENCE_POLICY,
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
} from './cross-house-policy';

describe('cross-house equivalence policy', () => {
  it('keeps every role on an equal runtime tier across houses', () => {
    for (const role of Object.values(CROSS_HOUSE_EQUIVALENCE_POLICY)) {
      for (const tier of Object.values(role.tiers)) {
        expect(tier.anthropic[0]?.runtimeTier).toBe(tier.openai[0]?.runtimeTier);
      }
    }
  });

  it('routes orchestrators in both directions at the frontier model tier', () => {
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'claude' }))
      .toMatchObject({
        fromBackend: 'claude',
        toBackend: 'codex',
        fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
        toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
        action: 'handoff',
      });
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'codex' }))
      .toMatchObject({
        fromBackend: 'codex',
        toBackend: 'claude',
        fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
        toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
        action: 'handoff',
      });
  });

  it('preserves a selected standard model tier instead of dropping lower', () => {
    expect(resolveCrossHouseFallback({
      role: 'worker',
      backend: 'codex',
      model: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.openai,
    })).toMatchObject({
      modelTier: 'reviewMechanical',
      toModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
    });
  });

  it('holds visibly when the other subscription house is unavailable', () => {
    const decision = resolveCrossHouseFallback({
      role: 'orchestrator',
      backend: 'claude',
      subscriptionProfile: 'claude-only',
    });
    expect(decision?.action).toBe('hold');
    expect(buildCrossHouseFallbackMessage(decision!)).toContain('without metered fallback');
  });

  it('does not treat the metered Fable backend as a subscription surface', () => {
    expect(resolveCrossHouseFallback({ role: 'orchestrator', backend: 'fable' })).toBeNull();
  });

  it.each([
    ['Codex structured usage cap', { type: 'turn.failed', error: { code: 'usage_limit_reached', message: 'You have hit your usage limit. Try again when it resets.' } }],
    ['Codex workspace cap', { type: 'turn.failed', error: { code: 'workspace_member_usage_limit_reached' } }],
    ['Claude Code subscription cap', { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your usage limit" }],
    ['Claude Code disabled allocation', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Your usage allocation has been disabled by your admin' }],
    ['Claude Code organization disabled subscription', 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead'],
  ])('recognizes the observed exhaustion frame: %s', (_name, frame) => {
    expect(isRuntimeQuotaLimitError(frame)).toBe(true);
  });

  it.each([
    ['single 429', { status: 429, message: 'Too Many Requests' }],
    ['same-window retry', { status: 429, message: 'Too Many Requests', headers: { 'retry-after': '10' } }],
    ['retry-after overrides quota-looking text', { status: 429, message: 'You have hit your usage limit.', headers: { 'retry-after': '10' } }],
    ['Claude transient limiter', { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Server is temporarily limiting requests (not your usage limit)' }],
    ['HTTP 500', { status: 500, message: 'Internal Server Error' }],
    ['HTTP 500 overrides a misleading quota code', { status: 500, code: 'usage_limit_reached', message: 'Internal Server Error' }],
    ['HTTP 503', 'HTTP 503 Service Unavailable'],
    ['network reset', new Error('ECONNRESET while reading response')],
    ['network timeout', new Error('ETIMEDOUT')],
    ['401 auth', { status: 401, message: 'Unauthorized: token expired' }],
    ['403 auth', { status: 403, message: 'Forbidden' }],
  ])('keeps transient/auth failures in-house: %s', (_name, frame) => {
    expect(isRuntimeQuotaLimitError(frame)).toBe(false);
  });
});
