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

vi.mock('@/lib/operator/role-routing-ledger', () => ({
  recordRoleRoutingReceiptSafely: vi.fn(),
}));

vi.mock('@/lib/operator/brain-routing', () => ({
  resolveBrainUseClaudeCliSync: vi.fn(),
  resolveBrainUseCodexCliSync: vi.fn(),
  usesManagedBrainInferenceSync: vi.fn(),
}));

import { composeClassA } from '@/lib/cortex/qa/compose-class-a';
import { isByokRequired } from '@/lib/cortex/qa/llm/byok-keys';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callOpenRouter } from '@/lib/cortex/qa/llm/openrouter-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { resolveBrainUseClaudeCliSync, resolveBrainUseCodexCliSync, usesManagedBrainInferenceSync } from '@/lib/operator/brain-routing';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';

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
    vi.mocked(recordRoleRoutingReceiptSafely).mockReset();
    vi.mocked(isByokRequired).mockResolvedValue(false);
    vi.mocked(getOperatorDefaultsSync).mockReturnValue({
      values: { classAComposer: 'auto' },
    } as ReturnType<typeof getOperatorDefaultsSync>);
    vi.mocked(resolveBrainUseClaudeCliSync).mockReturnValue(false);
    vi.mocked(resolveBrainUseCodexCliSync).mockReturnValue(true);
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(false);
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

  it('uses the managed route without a subscription fallback', async () => {
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(true);
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

  it('reports managed unavailability without launching a CLI', async () => {
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(true);
    vi.mocked(callOpenRouter).mockRejectedValue(new Error('HTTP 402'));
    const { events, emit } = makeEmit();

    await expect(composeClassA('What is the Brain-first rule?', '/repo/o8', [directiveRow], emit))
      .rejects.toMatchObject({ code: 'managed_brain_unavailable' });

    expect(callCodex).not.toHaveBeenCalled();
    expect(callHaiku).not.toHaveBeenCalled();
    expect(callSonnet).not.toHaveBeenCalled();
    expect(events.find((event) => event.name === 'token')).toBeUndefined();
  });

  it('uses the managed route when desktop BYOK is required', async () => {
    vi.mocked(usesManagedBrainInferenceSync).mockReturnValue(true);
    vi.mocked(isByokRequired).mockResolvedValue(true);
    vi.mocked(callOpenRouter).mockResolvedValue('Managed answer. [D-brain-first]');

    const { emit } = makeEmit();
    await composeClassA('What is the Brain-first rule?', '/repo/o8', [directiveRow], emit);

    expect(callOpenRouter).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ managedOnly: true }));
    expect(callCodex).not.toHaveBeenCalled();
  });

  it('receipts a disabled pinned CLI as a fallback instead of a selected route', async () => {
    vi.mocked(getOperatorDefaultsSync).mockReturnValue({
      values: { classAComposer: 'sonnet-cli', brainCodexModel: 'gpt-5.5', brainCodexEffort: 'high' },
      sources: { classAComposer: 'file', brainCodexModel: 'file', brainCodexEffort: 'file' },
    } as ReturnType<typeof getOperatorDefaultsSync>);
    vi.mocked(callCodex).mockResolvedValue('Fallback answer. [D-brain-first]');

    const { emit } = makeEmit();
    await composeClassA('What is the Brain-first rule?', '/repo/o8', [directiveRow], emit);

    expect(recordRoleRoutingReceiptSafely).toHaveBeenCalledWith(expect.objectContaining({
      role: 'brain',
      requested: expect.objectContaining({ backend: 'sonnet-cli' }),
      effective: expect.objectContaining({ runtime: 'codex' }),
      status: 'fallback',
      fallbackReason: expect.stringContaining('sonnet-cli'),
    }));
  });
});
