// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCommandPaletteHotkey } from './use-command-palette-hotkey';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [open, setOpen] = useState(false);
  useCommandPaletteHotkey(setOpen);
  return createElement(
    'div',
    null,
    createElement('output', { 'data-open': String(open) }),
    createElement('input', { 'aria-label': 'Composer' }),
    createElement('div', { className: 'xterm' }, createElement('textarea', { 'aria-label': 'Terminal' })),
  );
}

function paletteShortcut(init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'k',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

describe('useCommandPaletteHotkey', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('toggles on Command-K', () => {
    act(() => window.dispatchEvent(paletteShortcut()));
    expect(container.querySelector('output')?.dataset.open).toBe('true');

    act(() => window.dispatchEvent(paletteShortcut()));
    expect(container.querySelector('output')?.dataset.open).toBe('false');
  });

  it('leaves Command-Shift-K untouched', () => {
    const event = paletteShortcut({ shiftKey: true });
    act(() => window.dispatchEvent(event));

    expect(container.querySelector('output')?.dataset.open).toBe('false');
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens from a normal input but yields inside a terminal', () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Composer"]');
    const terminal = container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]');
    expect(input).not.toBeNull();
    expect(terminal).not.toBeNull();

    const inputEvent = paletteShortcut();
    act(() => input?.dispatchEvent(inputEvent));
    expect(container.querySelector('output')?.dataset.open).toBe('true');
    expect(inputEvent.defaultPrevented).toBe(true);

    const terminalEvent = paletteShortcut();
    act(() => terminal?.dispatchEvent(terminalEvent));
    expect(container.querySelector('output')?.dataset.open).toBe('true');
    expect(terminalEvent.defaultPrevented).toBe(false);
  });
});
