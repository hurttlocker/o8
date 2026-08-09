// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeO8SpecTargetPath, O8SpecTargetPicker } from './O8SpecTargetPicker';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('O8SpecTargetPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('normalizes a selected o8.md file to its repository directory', () => {
    expect(normalizeO8SpecTargetPath('/workspace/site/o8.md')).toBe('/workspace/site');
    expect(normalizeO8SpecTargetPath('C:\\workspace\\site\\o8.md')).toBe('C:\\workspace\\site');
    expect(normalizeO8SpecTargetPath('/workspace/site/')).toBe('/workspace/site');
  });

  it('selects a registered repo without adding or activating it', async () => {
    const onSelect = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      repos: [{ name: 'Outside repo', localPath: '/workspace/outside', exists: true }],
    }), { status: 200 })));

    act(() => root.render(createElement(O8SpecTargetPicker, {
      repoPath: '/workspace/current',
      defaultRepoPath: '/workspace/current',
      overridePath: null,
      onSelect,
      onFollowActiveRepo: vi.fn(),
    })));

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="o8.md target"]');
    act(() => trigger?.click());
    await act(async () => { await Promise.resolve(); });

    const outside = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Outside repo'));
    expect(outside).toBeDefined();
    act(() => outside?.click());
    expect(onSelect).toHaveBeenCalledWith('/workspace/outside');
  });
});
