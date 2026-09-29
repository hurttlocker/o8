// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  safeCancelIdleCallback,
  safeRequestIdleCallback,
  type SafeIdleCallbackHandle,
} from './webview-safe';

type IdlePair = {
  requestIdleCallback?: typeof window.requestIdleCallback;
  cancelIdleCallback?: typeof window.cancelIdleCallback;
};

function stashIdlePair(): IdlePair {
  return {
    requestIdleCallback: window.requestIdleCallback,
    cancelIdleCallback: window.cancelIdleCallback,
  };
}

function restoreIdlePair(saved: IdlePair): void {
  if (saved.requestIdleCallback) {
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: saved.requestIdleCallback,
    });
  } else {
    Reflect.deleteProperty(window, 'requestIdleCallback');
  }
  if (saved.cancelIdleCallback) {
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      writable: true,
      value: saved.cancelIdleCallback,
    });
  } else {
    Reflect.deleteProperty(window, 'cancelIdleCallback');
  }
}

function removeIdlePair(): void {
  Reflect.deleteProperty(window, 'requestIdleCallback');
  Reflect.deleteProperty(window, 'cancelIdleCallback');
}

describe('safeRequestIdleCallback / safeCancelIdleCallback', () => {
  let saved: IdlePair;

  beforeEach(() => {
    vi.useFakeTimers();
    saved = stashIdlePair();
  });

  afterEach(() => {
    restoreIdlePair(saved);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('absent APIs: fallback supplies a deterministic IdleDeadline and honors fallbackDelayMs', () => {
    removeIdlePair();

    const cb = vi.fn();
    safeRequestIdleCallback(cb, { fallbackDelayMs: 25 });

    vi.advanceTimersByTime(24);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();

    const deadline = cb.mock.calls[0]?.[0] as IdleDeadline;
    expect(deadline.didTimeout).toBe(true);
    expect(deadline.timeRemaining()).toBe(0);
  });

  it('absent APIs: cancel clears the scheduled timer so the callback never runs', () => {
    removeIdlePair();

    const cb = vi.fn();
    const handle = safeRequestIdleCallback(cb, { fallbackDelayMs: 10 });
    safeCancelIdleCallback(handle);

    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancel-only partial support: cancel clearsTimeout (does not call cancelIdleCallback)', () => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    const cancelIdle = vi.fn();
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      writable: true,
      value: cancelIdle,
    });

    const cb = vi.fn();
    const handle = safeRequestIdleCallback(cb, { fallbackDelayMs: 10 });
    safeCancelIdleCallback(handle);

    expect(cancelIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it('native request/cancel pair: schedules and cancels through the native APIs', () => {
    const nativeCb = vi.fn();
    const requestIdle = vi.fn((_cb: IdleRequestCallback, _opts?: IdleRequestOptions) => {
      // Capture but do not invoke — native path must not use setTimeout.
      return 42 as SafeIdleCallbackHandle;
    });
    const cancelIdle = vi.fn();

    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: requestIdle,
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      writable: true,
      value: cancelIdle,
    });

    const opts = { timeout: 1500 };
    const handle = safeRequestIdleCallback(nativeCb, opts);
    expect(requestIdle).toHaveBeenCalledOnce();
    expect(requestIdle).toHaveBeenCalledWith(nativeCb, opts);
    expect(handle).toBe(42);

    // Advancing timers must not fire the callback — native owns scheduling.
    vi.advanceTimersByTime(5_000);
    expect(nativeCb).not.toHaveBeenCalled();

    safeCancelIdleCallback(handle);
    expect(cancelIdle).toHaveBeenCalledOnce();
    expect(cancelIdle).toHaveBeenCalledWith(42);
  });
});
