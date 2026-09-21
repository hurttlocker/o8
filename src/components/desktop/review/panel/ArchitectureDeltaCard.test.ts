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
    omittedPaths: [],
    resolutionWarnings: [],
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
      root.render(createElement(ArchitectureDeltaCard, {
        analysis,
        scopePaths: ['src/feature.ts'],
        onSelectFile,
      }));
    });

    expect(container.textContent).toContain('Architecture delta');
    expect(container.textContent).toContain('feature.ts');
    expect(container.textContent).toContain('removed');

    const moduleNode = container.querySelector<SVGGElement>('g[aria-label="Module src/feature.ts, changed"]');
    expect(moduleNode).not.toBeNull();
    await act(async () => { moduleNode?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const button = container.querySelector<HTMLButtonElement>('button[title="Open src/feature.ts diff"]');
    expect(button).not.toBeNull();
    await act(async () => { button?.click(); });
    expect(onSelectFile).toHaveBeenCalledWith('src/feature.ts');
  });

  it('keeps large graphs at readable node size inside a two-axis viewport', async () => {
    const nodes = Array.from({ length: 30 }, (_, index) => ({
      path: `src/module-${index}.ts`,
      state: 'changed' as const,
      focusPath: `src/module-${index}.ts`,
    }));
    const largeAnalysis: ArchitectureDeltaState = {
      ...analysis,
      result: {
        ...analysis.result!,
        nodes,
        edges: [],
        summary: { changedModules: nodes.length, addedEdges: 0, removedEdges: 0, contextEdges: 0 },
      },
    };
    await act(async () => {
      root.render(createElement(ArchitectureDeltaCard, {
        analysis: largeAnalysis,
        scopePaths: nodes.map((node) => node.path),
        onSelectFile: vi.fn(),
      }));
    });

    const svg = container.querySelector('svg[aria-label^="Architecture dependency map"]');
    expect(Number(svg?.getAttribute('height'))).toBeGreaterThan(350);
    expect((svg?.parentElement as HTMLElement | null)?.style.overflow).toBe('auto');
    expect((svg?.parentElement as HTMLElement | null)?.style.maxHeight).toBe('350px');
  });
});
