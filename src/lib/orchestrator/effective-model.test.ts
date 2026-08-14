import { describe, expect, it } from 'vitest';

import { resolveEffectiveOrchestratorModel } from './effective-model';

describe('resolveEffectiveOrchestratorModel', () => {
  it('reports the carrier model when Claude Code is backed by a Codex subscription', () => {
    expect(resolveEffectiveOrchestratorModel({
      backend: 'claude',
      configuredModel: 'claude-opus-4-8',
      harnessSource: 'codex-subscription',
      harnessModel: 'gpt-5.6-sol',
    })).toBe('gpt-5.6-sol');
  });

  it('keeps the configured model for native Claude Code and other backends', () => {
    expect(resolveEffectiveOrchestratorModel({
      backend: 'claude',
      configuredModel: 'claude-opus-4-8',
      harnessSource: 'native',
      harnessModel: null,
    })).toBe('claude-opus-4-8');
    expect(resolveEffectiveOrchestratorModel({
      backend: 'codex',
      configuredModel: 'gpt-5.6-sol',
      harnessSource: 'openrouter',
      harnessModel: 'some/other-model',
    })).toBe('gpt-5.6-sol');
  });

  it('resolves the auto backend through the in-app orchestrator toggle', () => {
    expect(resolveEffectiveOrchestratorModel({
      backend: 'auto',
      configuredModel: 'claude-opus-4-8',
      inAppOrchestratorEnabled: true,
      harnessSource: 'codex-subscription',
      harnessModel: 'gpt-5.6-sol',
    })).toBe('gpt-5.6-sol');
    expect(resolveEffectiveOrchestratorModel({
      backend: 'auto',
      configuredModel: 'gpt-5.6-sol',
      inAppOrchestratorEnabled: false,
      harnessSource: 'openrouter',
      harnessModel: 'some/other-model',
    })).toBe('gpt-5.6-sol');
  });
});
