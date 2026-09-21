// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchitectureDeltaState } from '../useArchitectureDelta';
import { ArchitectureDeltaCard } from './ArchitectureDeltaCard';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const analysis: ArchitectureDeltaState = {
  loading: false,
  error: null,
  refresh: async () => undefined,
  result: {
    ok: true,
    status: 'ready',
    reason: null,
    nodes: [
      { path: 'src/feature.ts', state: 'changed', focusPath: 'src/feature.ts' },
      { path: 'src/core.ts', state: 'context', focusPath: null },
    ],
    edges: [
      { from: 'src/feature.ts', to: 'src/core.ts', state: 'removed', focusPath: 'src/feature.ts' },
    ],
    summary: { changedModules: 1, addedEdges: 0, removedEdges: 1, contextEdges: 0 },
    unsupportedPaths: [],
    truncated: false,
    generatedAt: '2026-09-21T00:00:00.000Z',
  },
};

describe('ArchitectureDeltaCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('shows structural evidence and opens the matching file diff', async () => {
    const onSelectFile = vi.fn();
    await act(async () => {
      root.render(createElement(ArchitectureDeltaCard, { analysis, onSelectFile }));
    });

    expect(container.textContent).toContain('Architecture delta');
    expect(container.textContent).toContain('feature.ts');
    expect(container.textContent).toContain('removed');

    const button = container.querySelector<HTMLButtonElement>('button[title="Open src/feature.ts diff"]');
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); });
    expect(onSelectFile).toHaveBeenCalledWith('src/feature.ts');
  });
});
