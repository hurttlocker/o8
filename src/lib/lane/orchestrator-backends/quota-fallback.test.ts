import { describe, expect, it } from 'vitest';
import { CROSS_HOUSE_MODEL_TIERS } from '@/lib/models';
import {
  buildCrossHouseHandoffMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseOrchestratorFallback,
} from './quota-fallback';

describe('cross-house orchestrator quota fallback', () => {
  it('detects usage-limit failures from runtime-adapter errors', () => {
    expect(isRuntimeQuotaLimitError(new Error('Claude weekly limit reached; limit resets Jul 8'))).toBe(true);
    expect(isRuntimeQuotaLimitError('429 too many requests: exceeded your current quota')).toBe(true);
    expect(isRuntimeQuotaLimitError(new Error('process exited with code 1'))).toBe(false);
  });

  it('routes Anthropic frontier orchestrators sideways to Codex best tier', () => {
    const fallback = resolveCrossHouseOrchestratorFallback('claude');

    expect(fallback).toEqual({
      fromBackend: 'claude',
      toBackend: 'codex',
      fromHouse: 'anthropic',
      toHouse: 'openai',
      fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
      toModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
      tier: 'frontierOrchestrator',
      noticeKind: 'cross-house-orchestrator-handoff',
    });
  });

  it('does not degrade non-Anthropic orchestrators or hide the handoff in copy', () => {
    expect(resolveCrossHouseOrchestratorFallback('codex')).toBeNull();

    const fableFallback = resolveCrossHouseOrchestratorFallback('fable');
    expect(fableFallback?.toBackend).toBe('codex');
    expect(buildCrossHouseHandoffMessage(fableFallback!)).toContain('acting orchestrator on this mission thread');
  });

  it('degrades Anthropic single-sub orchestrators within house', () => {
    const fallback = resolveCrossHouseOrchestratorFallback('claude', {
      subscriptionProfile: 'claude-only',
      currentModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
    });

    expect(fallback).toMatchObject({
      fromBackend: 'claude',
      toBackend: 'claude',
      fromHouse: 'anthropic',
      toHouse: 'anthropic',
      fromModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic,
      toModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
      action: 'downgrade',
      noticeKind: 'cross-house-orchestrator-handoff',
    });
    expect(buildCrossHouseHandoffMessage(fallback!)).toBe('Claude quota hit — orchestrator degraded to Sonnet 5 until reset.');
  });

  it('holds loudly when the single-sub profile is already at the low tier', () => {
    const fallback = resolveCrossHouseOrchestratorFallback('claude', {
      subscriptionProfile: 'claude-only',
      currentModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
    });

    expect(fallback).toMatchObject({
      fromBackend: 'claude',
      toBackend: 'claude',
      fromHouse: 'anthropic',
      toHouse: 'anthropic',
      fromModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
      toModel: CROSS_HOUSE_MODEL_TIERS.reviewMechanical.anthropic,
      action: 'hold',
      noticeKind: 'cross-house-orchestrator-handoff',
    });
    expect(buildCrossHouseHandoffMessage(fallback!)).toBe('quota exhausted — paused until reset');
  });

  it('holds Codex-only quota exhaustion instead of crossing houses', () => {
    const fallback = resolveCrossHouseOrchestratorFallback('codex', {
      subscriptionProfile: 'codex-only',
      currentModel: CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai,
    });

    expect(fallback).toMatchObject({
      fromBackend: 'codex',
      toBackend: 'codex',
      fromHouse: 'openai',
      toHouse: 'openai',
      action: 'hold',
      noticeKind: 'cross-house-orchestrator-handoff',
    });
  });
});
