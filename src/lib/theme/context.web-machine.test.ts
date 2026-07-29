// @vitest-environment jsdom

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

describe('ThemeProvider web-machine presentation', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    localStorage.setItem('cortex-workspace-glass', 'true');
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'o8-auth-mode');
    meta.setAttribute('content', 'web-machine');
    document.head.appendChild(meta);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-surface');
    document.documentElement.removeAttribute('data-workspace-glass');
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('data-palette');
    document.body.removeAttribute('data-surface');
    document.body.style.removeProperty('background');
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('pins solid while preserving the stored light and glass preferences', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const snapshots: ThemeSnapshot[] = [];

    act(() => {
      root.render(createElement(
        ThemeProvider,
        null,
        createElement(Harness, { onTheme: (value) => { snapshots.push(value); } }),
      ));
    });

    const theme = snapshots.at(-1);
    expect(theme?.surface).toBe('solid');
    expect(theme?.paletteId).toBe('light');
    expect(theme?.workspaceGlass).toBe(true);
    expect(theme?.themeId).toBe('light');
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.workspaceGlass).toBeUndefined();
    expect(localStorage.getItem('cortex-reduce-transparency')).toBe('off');
    expect(localStorage.getItem('cortex-workspace-glass')).toBe('true');
    expect(setItem).not.toHaveBeenCalled();
  });
});
