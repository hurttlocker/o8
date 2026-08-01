// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDurableRefresh } from './durable-refresh';

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('startDurableRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses events immediately and the timer only as a fallback', async () => {
    const refresh = vi.fn();
    const stop = startDurableRefresh({ refresh, intervalMs: 300_000, events: ['o8:lifecycle-reconcile'] });

    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });

  it('defers hidden work and catches up once when the page becomes visible', async () => {
    const refresh = vi.fn();
    const stop = startDurableRefresh({ refresh, intervalMs: 60_000, events: ['o8:lifecycle-reconcile'] });

    setVisibility('hidden');
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(refresh).not.toHaveBeenCalled();

    setVisibility('visible');
    await vi.runAllTicks();
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
  });

  it('coalesces lifecycle bursts during an in-flight refresh', async () => {
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const stop = startDurableRefresh({ refresh, intervalMs: 300_000, events: ['o8:lifecycle-reconcile'] });

    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    await vi.runAllTicks();
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
  });
});
