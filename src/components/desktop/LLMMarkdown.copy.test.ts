// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLLMMarkdown } from './LLMMarkdown';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

/** Exact fenced code body — copy must write this verbatim. */
const CODE_FIXTURE = [
  'export function greet(name: string) {',
  '  return `hello ${name}`;',
  '}',
].join('\n');

const MARKDOWN_FIXTURE = ['```ts', CODE_FIXTURE, '```'].join('\n');

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

describe('LLMMarkdown code-block copy feedback awaits clipboard success', () => {
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

  function renderMarkdown() {
    act(() => {
      root.render(createElement('div', null, ...renderLLMMarkdown(MARKDOWN_FIXTURE)));
    });
  }

  it('shows Copied only after a successful clipboard write of the exact code', async () => {
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

    renderMarkdown();
    const button = copyButton(container);
    expect(button).not.toBeNull();
    expect(copyLabel(button!)).toBe('Copy');

    await act(async () => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(CODE_FIXTURE);
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

    renderMarkdown();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(CODE_FIXTURE);
    expect(copyLabel(button)).toBe('Copy');
    expect(button.disabled).toBe(false);

    // Retry still invokes writeText with the same exact code.
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(CODE_FIXTURE);
    expect(copyLabel(button)).toBe('Copy');
  });

  it('does not claim Copied when the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    renderMarkdown();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(copyLabel(button)).toBe('Copy');
  });
});
