// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { generateClipPath } from '@lisse/core';
import { expect, it, vi } from 'vitest';
import { DashboardFrame } from './DashboardFrame';

it('clips dashboard frames from observed layout without synchronous style reads or remounting children', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let observe!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observe = callback; }
    observe() {}
    unobserve() {}
    disconnect = disconnect;
  });
  const reads = vi.spyOn(window, 'getComputedStyle');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let corners = { radius: 14, smoothing: 0.6 };
  function Draft() {
    const [draft, setDraft] = useState('');
    return createElement('button', { onClick: () => setDraft('Unsent draft') }, draft || 'Edit draft');
  }
  const render = () => root.render(createElement(DashboardFrame, {
    corners, autoEffects: false, style: { width: 200, height: 100, boxSizing: 'border-box' },
  }, createElement(Draft)));
  try {
    await act(async () => render());
    expect(reads, 'mount must consume browser layout observations instead of forcing layout').not.toHaveBeenCalled();
    const frame = host.firstElementChild as HTMLDivElement;
    const resize = (width: number, height: number) => observe([{
      target: frame, borderBoxSize: [{ inlineSize: width, blockSize: height }],
    } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await act(async () => resize(200, 100));
    expect(frame.style.clipPath).toBe(generateClipPath(200, 100, corners));
    expect(frame.dataset.state).toBe('ready');
    const button = host.querySelector('button')!;
    await act(async () => button.click());
    corners = { radius: 20, smoothing: 0.7 };
    await act(async () => render());
    expect(frame.style.clipPath).toBe(generateClipPath(200, 100, corners));
    await act(async () => resize(320, 160));
    expect(frame.style.clipPath).toBe(generateClipPath(320, 160, corners));
    expect(host.querySelector('button')).toBe(button);
    expect(button.textContent).toBe('Unsent draft');
    expect(reads).not.toHaveBeenCalled();
    await act(async () => observe([{
      target: frame, borderBoxSize: { inlineSize: 360, blockSize: 180 },
    } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(frame.style.clipPath).toBe(generateClipPath(360, 180, corners));
    expect(reads).not.toHaveBeenCalled();
    await act(async () => observe([{ target: frame } as unknown as ResizeObserverEntry], {} as ResizeObserver));
    expect(frame.style.clipPath).toBe(generateClipPath(200, 100, corners));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    reads.mockRestore();
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledOnce();
});
