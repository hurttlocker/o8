import { describe, expect, it } from 'vitest';

import {
  buildMobileAskModelCatalog,
  normalizeMobileAskModelId,
  resolveMobileAskRoute,
} from './ask-model-routing';

describe('mobile Ask model routing', () => {
  it('always returns the five mobile-safe model ids with local availability', () => {
    const catalog = buildMobileAskModelCatalog({ claude: true, codex: false });

    expect(catalog.models.map((model) => model.id)).toEqual([
      'auto',
      'claude-sonnet',
      'claude-haiku',
      'codex-terra-xhigh',
      'managed-free',
    ]);
    expect(catalog.models.map((model) => [model.id, model.available])).toEqual([
      ['auto', true],
      ['claude-sonnet', true],
      ['claude-haiku', true],
      ['codex-terra-xhigh', false],
      ['managed-free', true],
    ]);
    expect(catalog.defaultModel).toBe('claude-sonnet');
  });

  it('chooses the default from Claude, Codex, then managed free', () => {
    expect(buildMobileAskModelCatalog({ claude: true, codex: true }).defaultModel).toBe('claude-sonnet');
    expect(buildMobileAskModelCatalog({ claude: false, codex: true }).defaultModel).toBe('codex-terra-xhigh');
    expect(buildMobileAskModelCatalog({ claude: false, codex: false }).defaultModel).toBe('managed-free');
  });

  it('ignores arbitrary model ids instead of forwarding them', () => {
    expect(normalizeMobileAskModelId('gpt-5.6-sol')).toBe('auto');
    expect(normalizeMobileAskModelId('claude-opus-4-8')).toBe('auto');
    expect(normalizeMobileAskModelId(undefined)).toBe('auto');

    expect(resolveMobileAskRoute('gpt-5.6-sol', { claude: false, codex: true })).toEqual({
      kind: 'codex',
      requestedModel: 'auto',
      cliModel: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });
  });

  it('routes Auto to Sonnet, then Terra xhigh, then a pre-stream managed fallback', () => {
    expect(resolveMobileAskRoute('auto', { claude: true, codex: true })).toMatchObject({
      kind: 'claude',
      cliModel: 'claude-sonnet-5',
    });
    expect(resolveMobileAskRoute('auto', { claude: false, codex: true })).toEqual({
      kind: 'codex',
      requestedModel: 'auto',
      cliModel: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });
    expect(resolveMobileAskRoute('auto', { claude: false, codex: false })).toEqual({
      kind: 'managed',
      requestedModel: 'auto',
      fallback: true,
    });
  });

  it('never crosses from an unavailable explicit CLI selection to the other CLI', () => {
    expect(resolveMobileAskRoute('claude-haiku', { claude: false, codex: true })).toEqual({
      kind: 'managed',
      requestedModel: 'claude-haiku',
      fallback: true,
    });
    expect(resolveMobileAskRoute('codex-terra-xhigh', { claude: true, codex: false })).toEqual({
      kind: 'managed',
      requestedModel: 'codex-terra-xhigh',
      fallback: true,
    });
    expect(resolveMobileAskRoute('managed-free', { claude: true, codex: true })).toEqual({
      kind: 'managed',
      requestedModel: 'managed-free',
      fallback: false,
    });
  });
});
