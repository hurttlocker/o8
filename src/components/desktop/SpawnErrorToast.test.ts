// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpawnErrorToast } from './SpawnErrorToast';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('SpawnErrorToast dismissal and timer cleanup', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders nothing for a null message and shows literal alert text for a message', () => {
    const onDismiss = vi.fn();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: null,
      onDismiss,
    })));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe('');

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'spawn failed: worktree missing',
      onDismiss,
    })));
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('spawn failed: worktree missing');
  });

  it('invokes onDismiss once from the dismiss control', () => {
    const onDismiss = vi.fn();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'broken spawn',
      onDismiss,
    })));

    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('auto-dismisses after twelve seconds for the current message', () => {
    const onDismiss = vi.fn();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'timed spawn failure',
      onDismiss,
    })));

    act(() => {
      vi.advanceTimersByTime(11_999);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('resets the auto-dismiss deadline when the message is replaced', () => {
    const onDismiss = vi.fn();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'first failure',
      onDismiss,
    })));

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'second failure',
      onDismiss,
    })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('second failure');

    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('clears the pending auto-dismiss timer on unmount', () => {
    const onDismiss = vi.fn();

    act(() => root.render(createElement(SpawnErrorToast, {
      message: 'unmount before deadline',
      onDismiss,
    })));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    act(() => root.unmount());

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // Recreate root so afterEach unmount stays safe.
    root = createRoot(container);
  });
});
