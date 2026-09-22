// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { defaultsFetch } = vi.hoisted(() => ({ defaultsFetch: vi.fn() }));
vi.mock('./operator-defaults-client', () => ({ fetchOperatorDefaults: defaultsFetch }));
vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ isFounder: false }) }));

import { ModelsTab } from './ModelsTab';
import { LocalModelsTab } from './LocalModelsTab';
import { SETTINGS_SEARCH_REGISTRY, searchSettings } from './settings-search';

const defaults = {
  values: { subscriptionProfile: 'hybrid', orchestratorBackend: 'codex', defaultDispatchRuntime: 'codex',
    targetingTriage: { runtime: 'codex', model: '', effort: 'low' }, targetingAction: { runtime: 'codex', model: '', effort: 'high' },
    reviewerBackend: 'auto', localInferenceBaseUrl: '', defaultDispatchModel: '', localEmbedModel: '', localChatModel: '' },
  sources: {},
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
    expect(container.querySelector('[data-settings-section="Advanced orchestrator options"]')?.closest('details')?.open).toBe(false);
    expect(tools?.open).toBe(false);
    expect(tools?.querySelector('summary')?.textContent).toContain('Ready: Antigravity');
    expect(tools?.textContent).not.toContain('Gemini');
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

  it('saves a local model through the existing defaults endpoint from its new page', async () => {
    await act(async () => root.render(createElement(LocalModelsTab)));
    const preset = [...container.querySelectorAll('button')].find(button => button.textContent === 'Ollama')!;
    await act(async () => preset.click());
    expect(defaultsFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: JSON.stringify({ defaultDispatchModel: 'ollama:qwen2.5-coder:32b' }) }));
  });
});
