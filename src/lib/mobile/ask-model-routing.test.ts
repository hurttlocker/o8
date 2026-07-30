import { describe, expect, it } from 'vitest';

import {
  buildMobileAskModelCatalog,
  normalizeMobileAskEffort,
  normalizeMobileAskModelId,
  resolveMobileAskEffort,
  resolveMobileAskRoute,
} from './ask-model-routing';

describe('mobile Ask model routing', () => {
  it('always returns the eight mobile-safe model ids with local availability', () => {
    const catalog = buildMobileAskModelCatalog({ claude: true, codex: false });

    expect(catalog.models.map((model) => model.id)).toEqual([
      'auto',
      'claude-sonnet',
      'claude-haiku',
      'claude-opus',
      'claude-fable',
      'codex-terra-xhigh',
      'codex-sol-xhigh',
      'managed-free',
    ]);
    expect(catalog.models.map((model) => [model.id, model.available])).toEqual([
      ['auto', true],
      ['claude-sonnet', true],
      ['claude-haiku', true],
      ['claude-opus', true],
      ['claude-fable', true],
      ['codex-terra-xhigh', false],
      ['codex-sol-xhigh', false],
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
      effort: 'xhigh',
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
      effort: 'xhigh',
    });
    expect(resolveMobileAskRoute('auto', { claude: false, codex: false })).toEqual({
      kind: 'managed',
      requestedModel: 'auto',
      fallback: true,
    });
  });

  it('routes the added Claude choices through their canonical Claude models', () => {
    expect(resolveMobileAskRoute('claude-opus', { claude: true, codex: true })).toEqual({
      kind: 'claude',
      requestedModel: 'claude-opus',
      cliModel: 'claude-opus-5',
      effort: 'xhigh',
    });
    expect(resolveMobileAskRoute('claude-fable', { claude: true, codex: true })).toEqual({
      kind: 'claude',
      requestedModel: 'claude-fable',
      cliModel: 'claude-fable-5',
      effort: 'xhigh',
    });
  });

  it('routes explicit Sol through Codex at xhigh without changing Auto', () => {
    expect(resolveMobileAskRoute('codex-sol-xhigh', { claude: true, codex: true })).toEqual({
      kind: 'codex',
      requestedModel: 'codex-sol-xhigh',
      cliModel: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    expect(resolveMobileAskRoute('auto', { claude: true, codex: true })).toMatchObject({
      kind: 'claude',
      cliModel: 'claude-sonnet-5',
    });
  });

  it('validates Ask effort and defaults arbitrary values to xhigh', () => {
    expect(normalizeMobileAskEffort('low')).toBe('low');
    expect(normalizeMobileAskEffort('medium')).toBe('medium');
    expect(normalizeMobileAskEffort('high')).toBe('high');
    expect(normalizeMobileAskEffort('xhigh')).toBe('xhigh');
    expect(normalizeMobileAskEffort('max')).toBe('xhigh');
    expect(normalizeMobileAskEffort('ultra')).toBe('xhigh');
    expect(normalizeMobileAskEffort(undefined)).toBe('xhigh');
  });

  it('carries validated effort through Auto and explicit local routes', () => {
    expect(resolveMobileAskRoute('auto', { claude: true, codex: true }, 'low')).toMatchObject({
      kind: 'claude',
      cliModel: 'claude-sonnet-5',
      effort: 'low',
    });
    expect(resolveMobileAskRoute('auto', { claude: false, codex: true }, 'medium')).toMatchObject({
      kind: 'codex',
      cliModel: 'gpt-5.6-terra',
      effort: 'medium',
    });
    expect(resolveMobileAskRoute('claude-fable', { claude: true, codex: true }, 'high')).toMatchObject({
      kind: 'claude',
      cliModel: 'claude-fable-5',
      effort: 'high',
    });
    expect(resolveMobileAskRoute('codex-sol-xhigh', { claude: true, codex: true }, 'bogus')).toMatchObject({
      kind: 'codex',
      cliModel: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('clamps only Claude Opus low to medium', () => {
    expect(resolveMobileAskEffort('claude-opus', 'low')).toBe('medium');
    expect(resolveMobileAskRoute('claude-opus', { claude: true, codex: true }, 'low')).toMatchObject({
      kind: 'claude',
      cliModel: 'claude-opus-5',
      effort: 'medium',
    });

    expect(resolveMobileAskEffort('claude-opus', 'medium')).toBe('medium');
    expect(resolveMobileAskEffort('claude-sonnet', 'low')).toBe('low');
    expect(resolveMobileAskEffort('claude-fable', 'medium')).toBe('medium');
    expect(resolveMobileAskEffort('codex-sol-xhigh', 'medium')).toBe('medium');
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
    expect(resolveMobileAskRoute('claude-opus', { claude: false, codex: true })).toEqual({
      kind: 'managed',
      requestedModel: 'claude-opus',
      fallback: true,
    });
    expect(resolveMobileAskRoute('claude-fable', { claude: false, codex: true })).toEqual({
      kind: 'managed',
      requestedModel: 'claude-fable',
      fallback: true,
    });
    expect(resolveMobileAskRoute('codex-sol-xhigh', { claude: true, codex: false })).toEqual({
      kind: 'managed',
      requestedModel: 'codex-sol-xhigh',
      fallback: true,
    });
    expect(resolveMobileAskRoute('managed-free', { claude: true, codex: true }, 'low')).toEqual({
      kind: 'managed',
      requestedModel: 'managed-free',
      fallback: false,
    });
  });
});
