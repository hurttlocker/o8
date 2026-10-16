// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { O8RepoSelector } from './O8RepoSelector';
import type { RepoRegistryEntry } from '@/lib/repos/types';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('labels an explicitly selected worktree outside the current project without borrowing another repository name', async () => {
  const repos = [{ id: 'site', name: 'site', localPath: '/repos/site', remoteUrl: 'https://github.com/example/site' }] as RepoRegistryEntry[];
  const render = (selectedRepoPath: string | null, allRepos = false) => act(async () => root.render(createElement(O8RepoSelector, {
    repos, selectedRepoPath, allRepos, onSelectAll: () => {}, onSelectRepo: () => {},
  })));
  await render('/repos/app-worktree');
  expect(host.querySelector('button')?.textContent).toBe('app-worktree');
  await render('/repos/site');
  expect(host.querySelector('button')?.textContent).toBe('site');
  await render(null);
  expect(host.querySelector('button')?.textContent).toBe('No repo');
  await render('/repos/app-worktree', true);
  expect(host.querySelector('button')?.textContent).toBe('All repos');
});
