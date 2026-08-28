// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasSearchOverlay, type CanvasSearchSources } from './canvas-search';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const emptySources: CanvasSearchSources = {
  termCards: [],
  fileCards: [],
  imageCards: [],
  browserCards: [],
  chatCards: [],
  diffCards: [],
  specCards: [],
  brainCards: [],
  recentThreads: [],
};

type CanvasSearchOverlayProps = ComponentProps<typeof CanvasSearchOverlay>;

function responseWith(results: unknown[], ok = true): Response {
  return {
    ok,
    json: vi.fn(async () => ({ results })),
  } as unknown as Response;
}

describe('CanvasSearchOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchImpl = vi.fn<typeof fetch>();
  let onQueryChange = vi.fn<CanvasSearchOverlayProps['onQueryChange']>();
  let onClose = vi.fn<CanvasSearchOverlayProps['onClose']>();
  let onFocusCard = vi.fn<CanvasSearchOverlayProps['onFocusCard']>();
  let onPickThread = vi.fn<CanvasSearchOverlayProps['onPickThread']>();
  let spawnFileCard = vi.fn<CanvasSearchOverlayProps['spawnFileCard']>();

  const renderSearch = (query: string, sources: Partial<CanvasSearchSources> = {}) => {
    act(() => root.render(createElement(CanvasSearchOverlay, {
      ...emptySources,
      ...sources,
      query,
      activeRepoPath: '/fixture/repo',
      onQueryChange,
      onClose,
      onFocusCard,
      onPickThread,
      spawnFileCard,
      fetchImpl,
    })));
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fetchImpl = vi.fn<typeof fetch>();
    onQueryChange = vi.fn<CanvasSearchOverlayProps['onQueryChange']>();
    onClose = vi.fn<CanvasSearchOverlayProps['onClose']>();
    onFocusCard = vi.fn<CanvasSearchOverlayProps['onFocusCard']>();
    onPickThread = vi.fn<CanvasSearchOverlayProps['onPickThread']>();
    spawnFileCard = vi.fn<CanvasSearchOverlayProps['spawnFileCard']>();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('merges local cards and threads before repository files and symbols', async () => {
    fetchImpl.mockResolvedValue(responseWith([
      {
        kind: 'file',
        title: 'alpha-unopened.ts:4',
        detail: 'const alphaNeedle = true;',
        target: { filePath: 'src/alpha-unopened.ts', line: 4 },
      },
      {
        kind: 'symbol',
        title: 'function alphaSymbol',
        detail: 'src/symbols.ts:9',
        target: { filePath: 'src/symbols.ts', line: 9 },
      },
    ]));

    renderSearch('alpha', {
      fileCards: [{ id: 11, name: 'alpha-open.ts', path: '/fixture/repo/src/alpha-open.ts' }],
      recentThreads: [{
        id: 'thread-alpha',
        title: 'Alpha planning',
        repoPath: '/fixture/repo',
        repoName: 'repo',
        lastMessageAt: null,
      }],
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });

    const hits = Array.from(container.querySelectorAll<HTMLElement>('[data-search-hit-kind]'));
    expect(hits.map((hit) => hit.dataset.searchHitKind)).toEqual([
      'card',
      'thread',
      'repository',
      'repository',
    ]);
    expect(hits.map((hit) => hit.dataset.searchHitTitle)).toEqual([
      'alpha-open.ts',
      'Alpha planning',
      'alpha-unopened.ts:4',
      'function alphaSymbol',
    ]);
    expect(container.querySelector('[data-search-group="repository"]')?.textContent?.trim()).toBe('Repository');

    const requestUrl = new URL(String(fetchImpl.mock.calls[0][0]), 'http://localhost');
    expect(requestUrl.pathname).toBe('/api/panel/universal-search');
    expect(requestUrl.searchParams.get('workspace')).toBe('/fixture/repo');
    expect(requestUrl.searchParams.get('categories')).toBe('file,symbol');
  });

  it('does not call universal search for a query under two characters', async () => {
    renderSearch('a');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps local hits when universal search fails', async () => {
    fetchImpl.mockRejectedValue(new Error('offline'));
    renderSearch('alpha', {
      fileCards: [{ id: 12, name: 'alpha-local.ts', path: '/fixture/repo/src/alpha-local.ts' }],
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });

    const hits = Array.from(container.querySelectorAll<HTMLElement>('[data-search-hit-kind]'));
    expect(hits.map((hit) => hit.dataset.searchHitTitle)).toEqual(['alpha-local.ts']);
    expect(container.querySelector('[data-search-group="repository"]')).toBeNull();
  });

  it('opens a repository result through the injected file-card spawner', async () => {
    fetchImpl.mockResolvedValue(responseWith([{
      kind: 'file',
      title: 'repo-result.ts:3',
      detail: 'needle inside an unopened file',
      target: { filePath: 'src/repo-result.ts', line: 3 },
    }]));
    renderSearch('needle');
    await act(async () => { await vi.advanceTimersByTimeAsync(280); });

    const repositoryHit = container.querySelector<HTMLButtonElement>('[data-search-hit-kind="repository"]');
    expect(repositoryHit).not.toBeNull();
    act(() => repositoryHit?.click());

    expect(spawnFileCard).toHaveBeenCalledOnce();
    expect(spawnFileCard).toHaveBeenCalledWith('/fixture/repo/src/repo-result.ts');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onQueryChange).toHaveBeenCalledWith('');
  });
});
