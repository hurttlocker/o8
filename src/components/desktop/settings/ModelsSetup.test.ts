// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { defaultsFetch } = vi.hoisted(() => ({ defaultsFetch: vi.fn() }));
vi.mock('./operator-defaults-client', () => ({ fetchOperatorDefaults: defaultsFetch }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ isFounder: false }) }));

import { ModelsTab } from './ModelsTab';
import { OperatorDefaultsTab } from './OperatorDefaultsTab';
import { LocalModelsTab } from './LocalModelsTab';
import { GeneralTab } from './GeneralTab';
import { SETTINGS_SEARCH_REGISTRY, searchSettings } from './settings-search';

const defaults = {
  values: { subscriptionProfile: 'hybrid', orchestratorBackend: 'codex', defaultDispatchRuntime: 'codex',
    targetingTriage: { runtime: 'codex', model: '', effort: 'low' }, targetingAction: { runtime: 'codex', model: '', effort: 'high' },
    reviewerBackend: 'auto', localInferenceBaseUrl: '', defaultDispatchModel: '', localEmbedModel: '', localChatModel: '' },
  sources: {}, effectiveOverride: {},
};

describe('model setup navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    defaultsFetch.mockReset();
    defaultsFetch.mockImplementation(async () => Response.json(defaults));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/setup/detect') return Response.json({ tools: [
        { id: 'gemini', detected: true, ready: false },
        { id: 'antigravity', detected: true, ready: true },
      ] });
      return Response.json({});
    }));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('uses Antigravity detection and keeps optional setup collapsed while linking dedicated pages', async () => {
    const navigate = vi.fn();
    await act(async () => root.render(createElement(ModelsTab, { onNavigateTab: navigate })));
    const tools = container.querySelector('[data-settings-section="Connected tools"]')?.closest('details');
    expect(container.querySelector('[data-settings-section="Orchestrator"]')).not.toBeNull();
    expect(container.textContent).not.toContain('When set to Automatic, it uses Claude');
    expect(container.querySelector('[data-settings-section="OpenCode 2 models"]')).toBeNull();
    expect(container.querySelector('[data-settings-section="3code worker"]')).toBeNull();
    const fallback = [...container.querySelectorAll('span')].find(element => element.textContent === 'OpenCode fallback model');
    expect(fallback?.closest('details')?.querySelector('summary')?.dataset.settingsSection).toBe('Advanced orchestrator options');
    expect(container.querySelector('[data-settings-section="Advanced orchestrator options"]')?.closest('details')?.open).toBe(false);
    expect(tools?.open).toBe(false);
    expect(tools?.querySelector('summary')?.textContent).toContain('Ready: Antigravity');
    expect(tools?.textContent).toContain('Legacy Gemini CLI (gemini) for enterprise or paid API access');
    expect(tools?.textContent).toContain('Google Antigravity CLI (agy) for free and AI Pro/Ultra accounts');
    expect(tools?.textContent).toContain('GitHub Copilot CLI');
    expect(tools?.textContent).toContain('Not checked');
    const review = [...container.querySelectorAll('span')].find(element => element.textContent === 'Code review provider');
    expect(review).toBeDefined();
    expect(review?.closest('details')).toBeNull();
    const sections = [...container.querySelectorAll<HTMLElement>('[data-settings-section]')].map(element => element.dataset.settingsSection);
    expect(sections.indexOf('Engineering Brain')).toBeLessThan(sections.indexOf('Advanced orchestrator options'));
    expect(container.textContent).not.toContain('Spending limit per task');
    expect(container.querySelector('[data-settings-section="Advanced worker setup"]')?.closest('details')?.open).toBe(false);
    expect(container.querySelector('[data-settings-section="Claude Code settings"]')?.closest('details')?.open).toBe(false);
    const api = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Manage provider keys'))!;
    act(() => api.click());
    expect(navigate).toHaveBeenCalledWith('api-keys');
    expect(searchSettings(SETTINGS_SEARCH_REGISTRY, 'local endpoint', { founder: false })[0]?.tab).toBe('local-models');
  });

  it('opens Claude options when Claude is the selected chat provider', async () => {
    defaultsFetch.mockResolvedValue(Response.json({ ...defaults, values: { ...defaults.values, orchestratorBackend: 'claude' } }));
    await act(async () => root.render(createElement(ModelsTab)));
    expect(container.querySelector('[data-settings-section="Claude Code settings"]')?.closest('details')?.open).toBe(true);
  });

  it('saves the metered task limit from Dispatch without writing provider settings', async () => {
    await act(async () => root.render(createElement(OperatorDefaultsTab)));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Spending limit per task in USD"]')!;
    expect(input).not.toBeNull();
    input.value = '2.5';
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(defaultsFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: JSON.stringify({ meteredPacketCostCapUsd: 2.5 }) }));
    expect(searchSettings(SETTINGS_SEARCH_REGISTRY, 'Task spending limits', { founder: false })[0]?.tab).toBe('operator-defaults');
  });

  it('saves a local model through the existing defaults endpoint from its new page', async () => {
    await act(async () => root.render(createElement(LocalModelsTab)));
    const preset = [...container.querySelectorAll('button')].find(button => button.textContent === 'Ollama')!;
    await act(async () => preset.click());
    expect(defaultsFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: JSON.stringify({ defaultDispatchModel: 'ollama:qwen2.5-coder:32b' }) }));
  });

  it('shows the title inference control on the free plan and saves an off choice', async () => {
    defaultsFetch.mockResolvedValue(Response.json({
      ...defaults,
      values: { ...defaults.values, autoTitleInferenceEnabled: true },
    }));
    await act(async () => root.render(createElement(GeneralTab)));
    const conversations = container.querySelector('[data-settings-section="Conversations"]')?.parentElement;
    expect(conversations?.textContent).toContain('Model-generated titles');
    expect(conversations?.textContent).toContain('On by default');
    const control = conversations?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(control?.getAttribute('aria-checked')).toBe('true');
    await act(async () => control?.click());
    expect(defaultsFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', body: JSON.stringify({ autoTitleInferenceEnabled: false }),
    }));
  });
});
