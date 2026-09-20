// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLaneReviewChanges } from './useLaneReviewChanges';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('useLaneReviewChanges branch labels', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();

  function Consumer({ laneId }: { laneId: string | null }) {
    const changes = useLaneReviewChanges(laneId);
    return createElement('span', { 'data-files': JSON.stringify(changes.files.map((file) => file.path)), 'data-repo': changes.repoPath, 'data-loading': changes.loading }, changes.sourceLabel);
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('labels a materialized diff with its source and destination branches', async () => {
    fetchMock.mockResolvedValue(Response.json({
      ok: true,
      branch: 'fix/merge-beacon',
      base: 'abc123',
      diffBase: { baseBranch: 'release/next' },
      worktreePath: '/repo/.worktrees/merge-beacon',
      diff: '',
    }));

    await act(async () => {
      root.render(createElement(Consumer, { laneId: 'lane-branch-target' }));
    });

    expect(container.textContent).toBe('fix/merge-beacon → release/next');
  });

  it('keeps an unknown destination as a diff comparison and clears the old lane label while switching', async () => {
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(Response.json({
        ok: true,
        branch: 'fix/first',
        base: 'first-base',
        diffBase: { baseBranch: 'main' },
        worktreePath: '/repo/.worktrees/first',
        diff: '',
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));

    await act(async () => {
      root.render(createElement(Consumer, { laneId: 'lane-first' }));
    });
    expect(container.textContent).toBe('fix/first → main');

    await act(async () => {
      root.render(createElement(Consumer, { laneId: 'lane-second' }));
    });
    expect(container.textContent).toBe('Branch diff vs base');

    await act(async () => {
      resolveSecond(Response.json({
        ok: true,
        branch: 'fix/second',
        base: '8f7e6d5c',
        diffBase: {},
        worktreePath: null,
        diff: '',
      }));
    });
    expect(container.textContent).toBe('fix/second (diff vs 8f7e6d5c)');
  });
  it('ignores a previous lane response after the current lane has loaded', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
    await act(async () => { root.render(createElement(Consumer, { laneId: 'first' })); });
    await act(async () => { root.render(createElement(Consumer, { laneId: 'second' })); });
    const response = (name: string) => Response.json({
      ok: true, branch: `fix/${name}`, diffBase: { baseBranch: 'main' },
      worktreePath: `/repo/${name}`,
      diff: `diff --git a/${name}.ts b/${name}.ts\n--- a/${name}.ts\n+++ b/${name}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
    });
    await act(async () => { resolveSecond(response('second')); });
    expect(container.textContent).toBe('fix/second → main');
    expect(container.querySelector('span')?.dataset.files).toBe('["second.ts"]');
    await act(async () => { resolveFirst(response('first')); });
    expect(container.textContent).toBe('fix/second → main');
    expect(container.querySelector('span')?.dataset.files).toBe('["second.ts"]');
    expect(container.querySelector('span')?.dataset.repo).toBe('/repo/second');
  });

});
