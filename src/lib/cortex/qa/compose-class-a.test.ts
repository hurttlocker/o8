import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TypedRow } from '@/lib/cortex/qa/types';

const callOrder: string[] = [];

vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({
  isByokRequired: vi.fn(async () => false),
}));

vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({
  CODEX_DEFAULT_MODEL: 'gpt-5.5',
  callCodex: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({
  callHaiku: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  OPENROUTER_PRIMARY_MODEL: 'google/gemini-2.5-flash-lite',
  callOpenRouter: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({
  callSonnet: vi.fn(),
}));

vi.mock('@/lib/entitlement/store', () => ({
  getEntitlementSync: vi.fn(),
}));

vi.mock('@/lib/operator/defaults', () => ({
  getOperatorDefaultsSync: vi.fn(),
}));

vi.mock('@/lib/operator/brain-routing', () => ({
  resolveBrainUseClaudeCliSync: vi.fn(),
  resolveBrainUseCodexCliSync: vi.fn(),
}));

import { composeClassA } from '@/lib/cortex/qa/compose-class-a';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { resolveBrainUseClaudeCliSync, resolveBrainUseCodexCliSync } from '@/lib/operator/brain-routing';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';

const directiveRow: TypedRow = {
  citation: {
    kind: 'directive',
    rowId: 'brain-first',
    table: 'directives',
    excerpt: 'Use the Brain first.',
  },
  fields: {
    title: 'Brain-first directive',
    body: 'Use cortex_ask before broad repo search.',
  },
};

function makeEmit() {
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    emit: (name: string, payload: unknown) => {
      events.push({ name, payload });
    },
  };
}

describe('composeClassA provider order', () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.mocked(callCodex).mockReset();
    vi.mocked(callHaiku).mockReset();
    vi.mocked(callOpenRouter).mockReset();
    vi.mocked(callSonnet).mockReset();
    vi.mocked(getOperatorDefaultsSync).mockReturnValue({
      values: { classAComposer: 'auto' },
    } as ReturnType<typeof getOperatorDefaultsSync>);
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(false);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(true);
    vi.mocked(getEntitlementSync).mockReturnValue({
      flags: {},
    } as ReturnType<typeof getEntitlementSync>);
  });

  it('uses Codex CLI as the default subscription tier when the Claude Brain CLI is off', async () => {
    vi.mocked(callCodex).mockImplementation(async () => {
      callOrder.push('codex');
      return 'Use cortex_ask first. [D-brain-first]';
    });
    vi.mocked(callOpenRouter).mockImplementation(async () => {
      callOrder.push('openrouter');
      return 'paid fallback';
    });

    const { events, emit } = makeEmit();
    await composeClassA('How should the orchestrator learn repo conventions?', '/repo/o8', [directiveRow], emit);

    expect(callOrder).toEqual(['codex']);
    expect(callHaiku).not.toHaveBeenCalled();
    expect(callOpenRouter).not.toHaveBeenCalled();
    expect(events).toContainEqual({ name: 'done', payload: {} });
  });

  it('uses the managed fast tier before subscription CLIs without changing the cascade fallback', async () => {
    vi.mocked(getEntitlementSync).mockReturnValue({
      flags: { 'proxy.inference': true },
    } as ReturnType<typeof getEntitlementSync>);
    vi.mocked(callOpenRouter).mockImplementation(async () => {
      callOrder.push('openrouter');
      return 'Fast answer. [D-brain-first]';
    });
    vi.mocked(callCodex).mockImplementation(async () => {
      callOrder.push('codex');
      return 'subscription fallback';
    });

    const { events, emit } = makeEmit();
    await composeClassA('What is the Brain-first rule?', '/repo/o8', [directiveRow], emit);

    expect(callOrder).toEqual(['openrouter']);
    expect(callCodex).not.toHaveBeenCalled();
    expect(events).toContainEqual({ name: 'done', payload: {} });
  });
});
