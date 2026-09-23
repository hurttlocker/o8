// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoAnchorsRow } from './RepoAnchorsRow';
import { RepoScopeNotice } from './RepoScopeNotice';
import type { RepoFocusRepo } from './types';

const repos: RepoFocusRepo[] = [
  { id: 'web', name: 'sample-web', localPath: '/tmp/web', remoteUrl: null, defaultBranch: 'main' },
  { id: 'api', name: 'sample-api', localPath: '/tmp/api', remoteUrl: null, defaultBranch: 'main' },
];

describe('repository browse and work context', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('labels repository tabs as conversation filters', () => {
    const onSelect = vi.fn();
    act(() => root.render(createElement(RepoAnchorsRow, { repos, selectedRepoPath: null, onSelect })));

    expect(container.textContent).toContain('Browse conversations · filters this view only');
    const api = container.querySelector<HTMLButtonElement>('button[aria-label="Browse sample-api conversations"]');
    act(() => api?.click());
    expect(onSelect).toHaveBeenCalledWith('/tmp/api');
  });

  it('shows the mismatch and changes work context only through the explicit action', () => {
    const onWorkInRepo = vi.fn();
    act(() => root.render(createElement(RepoScopeNotice, {
      selectedRepo: repos[1], workingRepoPath: '/tmp/web', repos, onWorkInRepo,
    })));

    expect(container.textContent).toContain('Browsing sample-api conversations');
    expect(container.textContent).toContain('Working repository: sample-web');
    const action = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Work in this repository');
    act(() => action?.click());
    expect(onWorkInRepo).toHaveBeenCalledWith(repos[1]);
  });
});
