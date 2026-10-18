// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClaudeCodeWorkerProfile } from '@/lib/claude-code/worker-profile-types';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { ComposerPicker } from './ComposerPicker';
import { useComposerSelectorState } from './useComposerSelectorState';
import { invalidateRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ plan: 'pro' }) }));
vi.mock('../chat-panel/ComposerPopover', () => ({ ComposerPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? createElement('div', null, children) : null }));
const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let profile: ClaudeCodeWorkerProfile;
let configured: boolean;
let defaults: Record<string, unknown>;
let writes: Array<{ url: string; body: Record<string, unknown> }>;

function Harness() {
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-6-astra');
  const controller = useComposerSelectorState({ enabled: true, mode: 'fast', backend: 'codex', modelId: model, modelLabel: model, effort, operatorDefaultEffort: 'high', adaptiveEnabled: false, threadId: null, onEffortChange: setEffort, onModelChange: setModel });
  return createElement(ComposerPicker, { ...controller });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const click = async (selector: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); await settle(); }); };
beforeEach(async () => {
  localStorage.clear(); invalidateRuntimeInventory(); invalidateOperatorDefaultsValuesSnapshot();
  profile = { source: 'native', model: 'retained/model', codexModel: 'gpt-6-sol', repoSkillAllowlist: ['local-skill'] };
  configured = true; writes = [];
  defaults = { defaultDispatchRuntime: 'codex', defaultDispatchModel: 'gpt-6-sol', workerStartMode: 'huddle', opencodeWorkerModel: null };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ url, body });
    }
    const payload = url.includes('claude-code-profile') ? { profile, openrouterConfigured: configured, effectiveModel: profile.source === 'openrouter' ? profile.model : null }
      : url.includes('claude-code-models') ? { available: true, groups: [{ provider: 'openrouter', models: [{ id: 'openai/test-model', label: 'Test model', provider: 'openrouter', efforts: [] }] }] }
      : { values: defaults, sources: {}, dispatchableRuntimes: [ { id: 'codex', available: true }, { id: 'claude-code', available: true } ].map((runtime) => ({ ...runtime, label: runtime.id, installed: true, unavailableReason: null, detail: '', fix: '' })) };
    return new Response(JSON.stringify(payload), { status: 200 });
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); await settle(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it.each(['native', 'openrouter', 'codex-subscription'] as const)('keeps the configured %s worker carrier unchanged when choosing a lead', async source => {
  profile = { ...profile, source };
  const before = { ...profile };
  await click('[data-testid="composer-selector-lead"]');
  expect(container.querySelector('[data-testid^="worker-house-"]')).toBeNull();
  await click('[data-testid="lead-row-gpt-6-luna"]');
  expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('GPT-6 Luna');
  expect(profile).toEqual(before);
  expect(defaults.defaultDispatchRuntime).toBe('codex');
  expect(writes).toEqual([]);
});
