// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeRow } from './RuntimeRow';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const INSTALL_COMMAND = 'npm i -g @openai/codex';

function copyButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((candidate) => {
    const label = candidate.getAttribute('title') ?? '';
    return label === 'Copy install command' || label === 'Copied';
  }) ?? null;
}

describe('RuntimeRow install-command copy feedback', () => {
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

  function renderUndetectedCodex(onSelect?: () => void) {
    const row = createElement(RuntimeRow, {
      runtime: {
        id: 'codex',
        name: 'Codex CLI',
        detected: false,
      },
    });
    act(() => {
      root.render(
        onSelect
          ? createElement('div', { onClick: onSelect }, row)
          : row,
      );
    });
  }

  it('shows Copied only after a successful clipboard write of the exact command', async () => {
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

    renderUndetectedCodex();
    const button = copyButton(container);
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain(INSTALL_COMMAND);
    expect(button!.textContent).not.toContain('Copied');

    await act(async () => {
      button!.click();
    });

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    // Pending — still shows the command, not Copied.
    expect(button!.textContent).toContain(INSTALL_COMMAND);
    expect(button!.textContent).not.toContain('Copied');
    expect(button!.getAttribute('title')).toBe('Copy install command');

    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
    });

    expect(button!.textContent).toContain('Copied');
    expect(button!.textContent).not.toContain(INSTALL_COMMAND);
    expect(button!.getAttribute('title')).toBe('Copied');

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(button!.textContent).toContain(INSTALL_COMMAND);
    expect(button!.getAttribute('title')).toBe('Copy install command');
  });

  it('stays usable when clipboard write rejects', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderUndetectedCodex();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(button.textContent).toContain(INSTALL_COMMAND);
    expect(button.textContent).not.toContain('Copied');
    expect(button.getAttribute('title')).toBe('Copy install command');
    expect(button.disabled).toBe(false);
  });

  it('does not claim Copied when the clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });

    renderUndetectedCodex();
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(button.textContent).toContain(INSTALL_COMMAND);
    expect(button.textContent).not.toContain('Copied');
    expect(button.getAttribute('title')).toBe('Copy install command');
  });

  it('copies without firing a parent row selection handler', async () => {
    const writeText = vi.fn(async () => undefined);
    const onSelect = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderUndetectedCodex(onSelect);
    const button = copyButton(container)!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(INSTALL_COMMAND);
    expect(onSelect).not.toHaveBeenCalled();
    expect(button.textContent).toContain('Copied');
  });

  it('never executes the install command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execSpy = vi.spyOn(globalThis, 'eval' as never).mockImplementation(() => {
      throw new Error('eval must not run');
    });

    renderUndetectedCodex();
    const button = copyButton(container)!;
    expect(button.textContent).toContain(INSTALL_COMMAND);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    // Feedback path only writes to clipboard — no shell / eval side effects.
    expect(writeText).toHaveBeenCalledOnce();
    expect(execSpy).not.toHaveBeenCalled();
    expect(container.querySelector('a[href^="npm"]')).toBeNull();
  });
});
