// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AcpModelPicker } from './AcpModelPicker';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const rankedGroups = [{
  provider: 'openrouter',
  models: [
    { id: 'openrouter/beta/model', label: 'Beta Model', provider: 'openrouter', efforts: [], metadata: { rank: 0, compatible: true, free: false } },
    { id: 'openrouter/alpha/model', label: 'Alpha Model', provider: 'openrouter', efforts: [{ effort: 'high', id: 'openrouter/alpha/model/high' }], metadata: { rank: 1, compatible: true, free: true } },
    { id: 'openrouter/media/image', label: 'Image Model', provider: 'openrouter', efforts: [], metadata: { rank: 2, compatible: false, free: false } },
    { id: 'openrouter/media/audio', label: 'Audio Model', provider: 'openrouter', efforts: [], metadata: { rank: 3, compatible: false, free: false } },
    { id: 'openrouter/other/model', label: 'Other Model', provider: 'openrouter', efforts: [] },
  ],
}, {
  provider: 'google',
  models: [{ id: 'google/model', label: 'Google Model', provider: 'google', efforts: [] }],
}];

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function search(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AcpModelPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps runtime ids authoritative while ranking compatible OpenRouter models and filtering known-free choices', async () => {
    localStorage.setItem('o8:acp-model-recents:opencode', JSON.stringify(['openrouter/alpha/model/high', 'stale/model']));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ groups: rankedGroups, rankingAvailable: true })));
    const onSelect = vi.fn();

    await act(async () => {
      root.render(createElement(AcpModelPicker, { backend: 'opencode', value: 'openrouter/beta/model', onSelect }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Recent');
    expect(container.textContent).toContain('OpenRouter');
    expect(container.textContent).not.toContain('stale/model');
    const openRouterButton = container.querySelector<HTMLButtonElement>('button[aria-label="Provider OpenRouter"]')!;
    expect(openRouterButton.getAttribute('role')).toBeNull();
    expect(openRouterButton.parentElement?.getAttribute('role')).toBe('listitem');
    await act(async () => { openRouterButton.click(); });

    const ordered = [...container.querySelectorAll<HTMLButtonElement>('button[data-model-choice]')];
    expect(ordered.map((button) => button.title)).toEqual(['openrouter/beta/model', 'openrouter/alpha/model']);
    await act(async () => { search(container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!, 'Image'); });
    expect(container.querySelector('[title="openrouter/media/image"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Coding')?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { search(container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!, ''); });
    const allButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'All')!;
    expect(allButton.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { allButton.click(); });
    expect(container.querySelector('[title="openrouter/other/model"]')).not.toBeNull();
    expect(container.querySelector('[title="openrouter/media/image"]')).not.toBeNull();
    expect(container.querySelector('[title="openrouter/media/audio"]')).not.toBeNull();

    const freeButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Free')!;
    await act(async () => { freeButton.click(); });
    expect(container.querySelector('[title="openrouter/beta/model"]')).toBeNull();
    expect(container.querySelector('[title="openrouter/other/model"]')).toBeNull();
    expect(container.querySelector('[title="openrouter/alpha/model/high"]')?.getAttribute('aria-pressed')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="openrouter/alpha/model/high"]')!.click(); });
    expect(onSelect).toHaveBeenCalledWith('openrouter/alpha/model/high');
  });

  it('hides stale rows immediately when a reused picker switches catalogue sources', async () => {
    let resolveSecond: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ groups: rankedGroups, rankingAvailable: true }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();

    await act(async () => {
      root.render(createElement(AcpModelPicker, { backend: 'opencode', value: null, onSelect }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Provider OpenRouter"]')!.click(); });
    expect(container.querySelector('[title="openrouter/beta/model"]')).not.toBeNull();

    await act(async () => {
      root.render(createElement(AcpModelPicker, { backend: '3code', catalogueUrl: '/api/runtime/3code-models', value: null, onSelect }));
    });
    expect(container.querySelector('[title="openrouter/beta/model"]')).toBeNull();
    expect(container.querySelector('[role="option"]')).toBeNull();

    await act(async () => {
      resolveSecond?.(json({ groups: [{ provider: '3code', models: [{ id: '3code/model', label: '3Code Model', provider: '3code', efforts: [] }] }] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[title="3code/model"]')).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label^="Provider 3"]')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[title="3code/model"]')!.click(); });
    expect(onSelect).toHaveBeenLastCalledWith('3code/model');
  });

  it('keeps the selected provider and filters while switching OpenRouter rank order', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ groups: rankedGroups, rankingAvailable: true }))
      .mockResolvedValueOnce(json({ groups: rankedGroups, rankingAvailable: true }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(AcpModelPicker, { backend: 'opencode', value: null, onSelect: vi.fn() }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Provider OpenRouter"]')!.click(); });
    const allButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'All')!;
    const freeButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Free')!;
    await act(async () => { allButton.click(); freeButton.click(); });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Newest')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Provider OpenRouter"]')).toBeNull();
    expect(container.querySelector('[title="openrouter/alpha/model"]')).not.toBeNull();
    expect(container.querySelector('[title="openrouter/media/image"]')).toBeNull();
    expect(freeButton.getAttribute('aria-pressed')).toBe('true');
  });
  it('caps suggestions, surfaces stealth and the selected model, and searches the entire runtime list', async () => {
    const models = Array.from({ length: 40 }, (_, index) => ({ id: `openrouter/vendor/model-${index}`, label: `Model ${index}`, provider: 'openrouter', efforts: [], metadata: { rank: index, compatible: true } }));
    const stealth = { id: 'openrouter/stealth/hidden', label: 'Hidden model', provider: 'openrouter', efforts: [{ effort: 'high', id: 'openrouter/stealth/hidden/high' }], metadata: { rank: 42, compatible: true, stealth: true, contextLength: 200000, created: Date.now() / 1000, inputPricePerMillion: 1, outputPricePerMillion: 4 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ groups: [{ provider: 'openrouter', models: [...models, stealth] }], rankingAvailable: true })));
    const onSelect = vi.fn();
    await act(async () => { root.render(createElement(AcpModelPicker, { backend: 'opencode', defaultProvider: 'openrouter', value: models[30]!.id, onSelect, allowEffortVariants: false })); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.querySelectorAll('[data-model-choice]')).toHaveLength(18);
    expect(container.textContent).toContain('Stealth');
    expect(container.textContent).toContain('NEW');
    expect(container.textContent).toContain('200K context');
    expect(container.textContent).toContain('$1.00 / $4.00 per 1M');
    expect(container.querySelector('[title="openrouter/stealth/hidden/high"]')).toBeNull();
    expect(container.querySelector('[title="openrouter/vendor/model-30"]')).not.toBeNull();
    expect(container.querySelector('[title="openrouter/vendor/model-39"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Favorite Hidden model"]')!.click());
    expect(onSelect).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('o8:model-favorites:catalogue:opencode') ?? '[]')).toContainEqual({ house: 'opencode', id: stealth.id, label: stealth.label });
    act(() => search(container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!, 'model-39'));
    act(() => container.querySelector<HTMLButtonElement>('[title="openrouter/vendor/model-39"]')!.click());
    expect(onSelect).toHaveBeenCalledWith(models[39]!.id);
  });

});

it('shares hidden OpenRouter ids across runtime prefixes while keeping the selected model visible', async () => {
  localStorage.setItem('o8:openrouter-hidden-models', JSON.stringify(['beta/model']));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ groups: rankedGroups, rankingAvailable: true })));
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(AcpModelPicker, { backend: 'opencode', defaultProvider: 'openrouter', value: null, onSelect: () => {} })));
    expect(container.querySelector('[title="openrouter/beta/model"]')).toBeNull();
    await act(async () => root.render(createElement(AcpModelPicker, { backend: 'opencode', defaultProvider: 'openrouter', value: 'openrouter/beta/model', onSelect: () => {} })));
    expect(container.querySelector('[title="openrouter/beta/model"]')).not.toBeNull();
    await act(async () => root.render(createElement(AcpModelPicker, { backend: 'opencode', defaultProvider: 'openrouter', value: null, onSelect: () => {}, manageVisibility: true })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show Beta Model"]')!.click());
    expect(JSON.parse(localStorage.getItem('o8:openrouter-hidden-models')!)).toEqual([]);
  } finally { act(() => root.unmount()); localStorage.clear(); vi.unstubAllGlobals(); }
});
