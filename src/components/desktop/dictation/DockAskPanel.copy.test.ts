// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockAskPanel, type AskTurn } from './DockAskPanel';

const THREAD_FIXTURE: AskTurn[] = [
  { role: 'assistant', text: 'First **answer**.\nSecond line.' },
  { role: 'assistant', text: 'First **answer2**.\nSecond line.' },
];

const ACT_ENV = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('DockAskPanel copy feedback', () => {
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
    vi.clearAllTimers();
    vi.useRealTimers();
    container.remove();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
  });

  it('renders a copy control for each answer', () => {
    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: THREAD_FIXTURE,
          onClose: vi.fn(),
        }),
      );
    });

    expect(
      container.querySelectorAll('button[aria-label="Copy answer"]'),
    ).toHaveLength(2);
  });

  it('keeps Copy answer while the clipboard write is pending', () => {
    const writeText = vi.fn(() => new Promise<void>(() => {}));

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: THREAD_FIXTURE,
          onClose: vi.fn(),
        }),
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );

    expect(button).not.toBeNull();

    act(() => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(THREAD_FIXTURE[0].text);

    expect(button!.getAttribute('aria-label')).toBe('Copy answer');
  });

  it('shows Copied after a successful clipboard write', async () => {
    const writeText = vi.fn(() => Promise.resolve());

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: THREAD_FIXTURE,
          onClose: vi.fn(),
        }),
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );

    expect(button).not.toBeNull();

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(THREAD_FIXTURE[0].text);

    expect(button!.getAttribute('aria-label')).toBe('Copied');
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy answer');

    act(() => {
      vi.advanceTimersByTime(1399);
    });
    expect(button!.getAttribute('aria-label')).toBe('Copied');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button!.getAttribute('aria-label')).toBe('Copy answer');
  });

  it('keeps Copy answer when the clipboard write rejects', async () => {
    const writeText = vi.fn(() =>
      Promise.reject(new Error('Clipboard permission denied')),
    );

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: THREAD_FIXTURE,
          onClose: vi.fn(),
        }),
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(THREAD_FIXTURE[0].text);
    expect(buttons[0].getAttribute('aria-label')).toBe('Copy answer');
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy answer');
  });

  it('keeps Copy answer when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: THREAD_FIXTURE,
          onClose: vi.fn(),
        }),
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );
    expect(buttons).toHaveLength(2);

    await act(async () => {
      buttons[0].click();
    });

    expect(buttons[0].getAttribute('aria-label')).toBe('Copy answer');
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy answer');
  });

  it('does not copy whitespace-only answers', async () => {
    const writeText = vi.fn(() => Promise.resolve());

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    act(() => {
      root.render(
        createElement(DockAskPanel, {
          thread: [{ role: 'assistant', text: '   ' }],
          onClose: vi.fn(),
        }),
      );
    });

    const buttons = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Copy answer"]',
    );
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0].click();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(buttons[0].getAttribute('aria-label')).toBe('Copy answer');
  });
});
