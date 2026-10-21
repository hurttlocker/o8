// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { getMobilePalette } from '@/app/mobile/mobile-approvals-shared';
import { CapabilitiesSubView } from './sub-views';

it('keeps a loaded concurrency slider ceiling stable while lowering, saving, and restoring the value', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let values = {
    parallelCap: 64,
    thinkingEffort: 'high',
    defaultDispatchRuntime: 'codex',
    healBotEnabled: true,
    supervisorAutoEscalate: false,
  };
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') values = { ...values, ...JSON.parse(String(init.body)) };
    return Response.json({ values });
  });
  vi.stubGlobal('fetch', fetchMock);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CapabilitiesSubView, { palette: getMobilePalette('light') })));
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.max).toBe('64');
    expect(slider.value).toBe('64');
    const moveSlider = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await moveSlider('32');
    expect(slider.value).toBe('32');
    expect(slider.max).toBe('64');
    await act(async () => slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(values.parallelCap).toBe(32);
    expect(slider.max).toBe('64');
    await moveSlider('24');
    expect(slider.max).toBe('64');
    await moveSlider('64');
    expect(slider.value).toBe('64');
    await act(async () => slider.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(values.parallelCap).toBe(64);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
