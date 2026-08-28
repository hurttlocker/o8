// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCommandPaletteHotkey } from './use-command-palette-hotkey';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [commandOpen, setCommandOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  useCommandPaletteHotkey(setCommandOpen, 'k');
  useCommandPaletteHotkey(setFileOpen, 'p');
  return createElement(
    'div',
    null,
    createElement('output', { 'data-command-open': String(commandOpen), 'data-file-open': String(fileOpen) }),
    createElement('input', { 'aria-label': 'Composer' }),
    createElement('div', { className: 'xterm' }, createElement('textarea', { 'aria-label': 'Terminal' })),
  );
}

function paletteShortcut(key = 'k', init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
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
    expect(container.querySelector('output')?.dataset.commandOpen).toBe('true');

    act(() => window.dispatchEvent(paletteShortcut()));
    expect(container.querySelector('output')?.dataset.commandOpen).toBe('false');
  });

  it('toggles file mode on Command-P', () => {
    act(() => window.dispatchEvent(paletteShortcut('p')));
    expect(container.querySelector('output')?.dataset.fileOpen).toBe('true');

    act(() => window.dispatchEvent(paletteShortcut('p')));
    expect(container.querySelector('output')?.dataset.fileOpen).toBe('false');
  });

  it('leaves Command-Shift-K untouched', () => {
    const event = paletteShortcut('k', { shiftKey: true });
    act(() => window.dispatchEvent(event));

    expect(container.querySelector('output')?.dataset.commandOpen).toBe('false');
    expect(event.defaultPrevented).toBe(false);
  });

  it('opens from a normal input but yields inside a terminal', () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Composer"]');
    const terminal = container.querySelector<HTMLTextAreaElement>('[aria-label="Terminal"]');
    expect(input).not.toBeNull();
    expect(terminal).not.toBeNull();

    const inputEvent = paletteShortcut();
    act(() => input?.dispatchEvent(inputEvent));
    expect(container.querySelector('output')?.dataset.commandOpen).toBe('true');
    expect(inputEvent.defaultPrevented).toBe(true);

    const terminalEvent = paletteShortcut();
    act(() => terminal?.dispatchEvent(terminalEvent));
    expect(container.querySelector('output')?.dataset.commandOpen).toBe('true');
    expect(terminalEvent.defaultPrevented).toBe(false);

    const fileInputEvent = paletteShortcut('p');
    act(() => input?.dispatchEvent(fileInputEvent));
    expect(container.querySelector('output')?.dataset.fileOpen).toBe('true');
    expect(fileInputEvent.defaultPrevented).toBe(true);

    const fileTerminalEvent = paletteShortcut('p');
    act(() => terminal?.dispatchEvent(fileTerminalEvent));
    expect(container.querySelector('output')?.dataset.fileOpen).toBe('true');
    expect(fileTerminalEvent.defaultPrevented).toBe(false);
  });
});
