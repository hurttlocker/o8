// @vitest-environment jsdom

/**
 * The pre-paint stamp and ThemeProvider resolve the same thing twice, in two languages.
 * Divergence is invisible in review and shows up as a wrong-coloured flash before
 * hydration — the exact class the layout's warning comment was written about. These
 * cases run the real script string the layout injects.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PRE_PAINT_THEME_STAMP } from './pre-paint-stamp';

function runStamp(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(PRE_PAINT_THEME_STAMP)();
}

function markWebMachine(): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'o8-auth-mode');
  meta.setAttribute('content', 'web-machine');
  document.head.appendChild(meta);
}

describe('pre-paint theme stamp', () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
    for (const attribute of ['theme', 'palette', 'surface']) {
      document.documentElement.removeAttribute(`data-${attribute}`);
    }
    document.documentElement.style.removeProperty('--o8-boot-cover-bg');
  });

  it('pins solid and keeps the stored palette when the page is relayed to a browser', () => {
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    localStorage.setItem('cortex-workspace-glass', 'true');
    markWebMachine();

    runStamp();

    // Matches ThemeProvider: forceSolid wins, All Glass is ignored, palette survives.
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.palette).toBe('light');
    expect(localStorage.getItem('cortex-workspace-glass')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--o8-boot-cover-bg')).toBe('#F4F2ED');
  });

  it('still paints dark glass for All Glass on the machine itself', () => {
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-workspace-glass', 'true');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.dataset.palette).toBe('dark');
  });

  it('honours a stored glass preference locally', () => {
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'off');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.dataset.palette).toBe('dark');
  });

  it('defaults a first-run visitor to light solid', () => {
    runStamp();

    expect(document.documentElement.dataset.palette).toBe('light');
    expect(document.documentElement.dataset.surface).toBe('solid');
  });
});
