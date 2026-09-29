// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffCard } from './DiffCard';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

/** Static unified-diff fixture — copy must use this exact original text. */
const DIFF_FIXTURE = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,3 +1,4 @@',
  ' export function greet() {',
  '-  return "hi";',
  '+  return "hello";',
  '+  // copied verbatim',
  ' }',
].join('\n');

function copyButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((candidate) => {
    const label = candidate.textContent ?? '';
    return label.includes('Copy') || label.includes('Copied');
  }) ?? null;
}

function copyLabel(button: HTMLButtonElement): 'Copy' | 'Copied' | 'other' {
  const text = button.textContent ?? '';
  if (text.includes('Copied')) return 'Copied';
  if (text.includes('Copy')) return 'Copy';
  return 'other';
}

describe('DiffCard copy feedback reflects clipboard result', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClipboard: Clipboard | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalClipboard = navigator.clipboard;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderCard() {
    act(() => {
      root.render(createElement(DiffCard, { code: DIFF_FIXTURE }));
    });
  }

  it('shows Copied only after a successful clipboard write of the exact original diff', async () => {
    let resolveWrite: ((value: void) => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderCard();
    const button = copyButton(container);
    expect(button).not.toBeNull();
    expect(copyLabel(button!)).toBe('Copy');

    await act(async () => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(DIFF_FIXTURE);
    // Pending — still Copy, not Copied.
    expect(copyLabel(button!)).toBe('Copy');

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(copyLabel(button!)).toBe('Copied');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(copyLabel(button!)).toBe('Copy');
  });

  it('stays retryable when clipboard write rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderCard();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(DIFF_FIXTURE);
    expect(copyLabel(button)).toBe('Copy');
    expect(button.disabled).toBe(false);

    // Retry still invokes writeText with the same original diff.
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(DIFF_FIXTURE);
    expect(copyLabel(button)).toBe('Copy');
  });

  it('does not claim Copied when the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    renderCard();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(copyLabel(button)).toBe('Copy');
  });
});
