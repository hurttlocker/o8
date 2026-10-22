// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { invalidateRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import { ComposerPicker } from './ComposerPicker';
import { useComposerSelectorState } from './useComposerSelectorState';
import { ModeChip } from './ModeChip';
import { composeComposerTurnMessage } from '../composer-mode';

vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ plan: 'free' }) }));
vi.mock('../chat-panel/ComposerPopover', () => ({ ComposerPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? createElement('div', null, children) : null }));
const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let personalPiDetected: boolean;
let defaults: Record<string, unknown>;
let writes: Record<string, unknown>[];

function Harness() {
  const [backend, setBackend] = useState<OrchestratorBackendSetting>('codex');
  const [model, setModel] = useState('gpt-6-astra');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const controller = useComposerSelectorState({ enabled: true, mode: 'fast', backend, modelId: model, modelLabel: backend === 'o8' ? 'o8' : 'Astra', effort, operatorDefaultEffort: 'high', adaptiveEnabled: false, threadId: null, onEffortChange: setEffort, onBackendChange: (next, nextModel) => { setBackend(next); setModel(nextModel ?? ''); } });
  return createElement('div', null,
    createElement(ComposerPicker, { ...controller }),
    createElement(ModeChip, { state: controller.state, onModeChange: vi.fn() }),
    createElement('output', { 'data-testid': 'wire-mode' }, JSON.stringify(composeComposerTurnMessage('Read package.json', controller.state.mode, false))),
  );
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const click = async (selector: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); await settle(); }); };
beforeEach(async () => {
  localStorage.clear(); invalidateRuntimeInventory(); invalidateOperatorDefaultsValuesSnapshot();
  personalPiDetected = false; writes = [];
  defaults = { defaultDispatchRuntime: 'codex', defaultDispatchModel: '', workerStartMode: 'autonomous', opencodeWorkerModel: null, threecodeWorkerModel: null };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('claude-code-profile')) return Response.json({ profile: { source: 'native', model: null, codexModel: null }, openrouterConfigured: false, effectiveModel: null });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body); defaults = { ...defaults, ...body };
    }
    return Response.json({ values: defaults, sources: {}, dispatchableRuntimes: listDispatchableRuntimes().map((id) => ({ id, label: id, available: id === 'pi-builtin' || (id === 'pi' && personalPiDetected), installed: id === 'pi-builtin' || (id === 'pi' && personalPiDetected), unavailableReason: id === 'pi-builtin' || (id === 'pi' && personalPiDetected) ? null : 'not_installed', detail: '', fix: '' })) });
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); await settle(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('offers one built-in Pi lead under o8 without an installed CLI or a Customize step', async () => {
  await click('[data-testid="composer-selector-lead"]');
  expect(container.querySelector('[data-testid="lead-house-pi"]')).toBeNull();
  await click('[data-testid="lead-house-o8"]');
  const choices = container.querySelectorAll('[data-model-choice]');
  expect(choices).toHaveLength(1);
  expect(container.textContent).toContain('Managed model');
  expect(container.textContent).not.toContain('built-in Pi');
  await click('[data-testid="lead-row-o8-free"]');
  expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toBe('o8');
  expect(container.querySelector('[data-testid="composer-selector-mode"]')?.getAttribute('aria-label')).toBe('Mode: Shared');
  expect(container.querySelector('[data-testid="wire-mode"]')?.textContent).toContain('[Mode: Shared]');
  await click('[data-testid="composer-selector-mode"]');
  const shared = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(button => button.textContent?.includes('Shared'));
  expect(shared?.disabled).toBe(false);
  expect(shared?.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
  expect(writes).toEqual([]);
});

it.each(['pi', 'pi-builtin'])('keeps a saved %s worker out of the lead composer without rewriting it', async runtime => {
  defaults.defaultDispatchRuntime = runtime;
  invalidateOperatorDefaultsValuesSnapshot();
  act(() => root.unmount()); root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); await settle(); });
  expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();
  await click('[data-testid="composer-selector-lead"]');
  expect(container.querySelector('[data-testid^="worker-house-"]')).toBeNull();
  expect(defaults.defaultDispatchRuntime).toBe(runtime);
  expect(writes).toEqual([]);
});
