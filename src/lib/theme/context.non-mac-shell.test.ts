// @vitest-environment jsdom

/**
 * Windows / Linux shells have no vibrancy backdrop, so glass chrome would
 * composite against nothing (#1743, #1673). ThemeProvider pins those hosts to
 * the opaque `solid` surface — through the real provider, against the real
 * `__O8_HOST_PLATFORM__` stamp the Rust initialization script writes, not
 * against `resolveSurface` in isolation.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from './context';

type ThemeSnapshot = ReturnType<typeof useTheme>;

let host: HTMLDivElement;
let root: Root;

function Harness({ onTheme }: { onTheme: (theme: ThemeSnapshot) => void }) {
  onTheme(useTheme());
  return null;
}

function stampHostPlatform(os: string): void {
  (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__ = os;
}

function render(): ThemeSnapshot | undefined {
  const snapshots: ThemeSnapshot[] = [];
  act(() => {
    root.render(createElement(
      ThemeProvider,
      null,
      createElement(Harness, { onTheme: (value) => { snapshots.push(value); } }),
    ));
  });
  return snapshots.at(-1);
}

describe('ThemeProvider on a non-macOS shell', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    // Operator explicitly chose dark GLASS + All Glass — the strongest case
    // for the pin: preferences say glass, the host cannot render it.
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    localStorage.setItem('cortex-workspace-glass', 'true');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__;
    for (const element of [document.documentElement, document.body]) {
      element.removeAttribute('data-theme');
      element.removeAttribute('data-palette');
      element.removeAttribute('data-surface');
    }
    document.documentElement.removeAttribute('data-workspace-glass');
    document.body.style.removeProperty('background');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('pins solid on Windows and ignores All Glass without rewriting preferences', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    stampHostPlatform('windows');

    const theme = render();

    expect(theme?.surface).toBe('solid');
    expect(theme?.paletteId).toBe('dark');
    expect(theme?.workspaceGlass).toBe(true);
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.workspaceGlass).toBeUndefined();
    expect(localStorage.getItem('cortex-reduce-transparency')).toBe('off');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('pins solid on Linux too', () => {
    stampHostPlatform('linux');

    expect(render()?.surface).toBe('solid');
  });

  it('leaves the macOS stamp on the glass path', () => {
    stampHostPlatform('macos');

    expect(render()?.surface).toBe('glass');
  });

  it('treats an unstamped host (browser, pre-#1743 shell) as macOS', () => {
    expect(render()?.surface).toBe('glass');
  });
});
