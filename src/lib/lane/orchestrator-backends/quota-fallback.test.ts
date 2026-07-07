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

    expect(fallback).toMatchObject({
      fromBackend: 'claude',
      toBackend: 'codex',
      fromHouse: 'anthropic',
      toHouse: 'openai',
      tier: 'frontierOrchestrator',
      noticeKind: 'cross-house-orchestrator-handoff',
    });
    expect(fallback?.fromModel).toBe(CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.anthropic);
    expect(fallback?.toModel).toBe(CROSS_HOUSE_MODEL_TIERS.frontierOrchestrator.openai);
  });

  it('does not degrade non-Anthropic orchestrators or hide the handoff in copy', () => {
    expect(resolveCrossHouseOrchestratorFallback('codex')).toBeNull();

    const fableFallback = resolveCrossHouseOrchestratorFallback('fable');
    expect(fableFallback?.toBackend).toBe('codex');
    expect(buildCrossHouseHandoffMessage(fableFallback!)).toContain('acting orchestrator on this mission thread');
  });
});
