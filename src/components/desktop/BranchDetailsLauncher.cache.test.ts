// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchDetailsLauncher } from './BranchDetailsLauncher';
import type { PrDetail } from './pr-panel/types';

const { workspaces } = vi.hoisted(() => ({ workspaces: new Map<string, { branch: string; repoSlug: string }>() }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style, inert, 'aria-hidden': hidden }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style, inert, 'aria-hidden': hidden }, children) }));
vi.mock('framer-motion', async original => ({ ...await original<typeof import('framer-motion')>(), useReducedMotion: () => true }));
vi.mock('./orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] }, workspaceTargets: [] }) }));
vi.mock('./o8-panel/workspace-rail/ChangesList', async original => ({
  ...await original<typeof import('./o8-panel/workspace-rail/ChangesList')>(),
  useWorkspaceChanges: (path: string) => ({ ...workspaces.get(path), files: [], loading: false, error: null, totalAdditions: 0, totalDeletions: 0, worktrees: [] }),
}));
vi.mock('./pr-panel/usePrDetail', () => ({ usePrDetail: (number: number | null) => ({ detail: number ? detail(number) : null }) }));
vi.mock('./use-thread-sources', () => ({ useThreadSources: () => [] }));
vi.mock('./use-o8-browser-tabs', () => ({ useO8BrowserTabs: () => [] }));
vi.mock('./desktop-status-bar/footer-ports', () => ({ FooterPorts: () => null }));
vi.mock('./desktop-status-bar/supervisor-inbox-store', () => ({ useSupervisorInboxCount: () => 0, openSupervisorInboxTab: vi.fn() }));

function detail(number: number): PrDetail {
  return { number, title: 'Fixture pull request', body: '', state: 'OPEN', author: 'fixture', headRefName: 'feature', baseRefName: 'main',
    additions: 0, deletions: 0, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: true,
    reviewDecision: null, statusCheckRollup: [], url: 'https://example.invalid/pr', files: [], reviewComments: [], issueComments: [] };
}

let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const checkout = '/workspace/shared-list-a';
const otherCheckout = '/workspace/shared-list-b';
const list = (number = 27, branch = 'feature') => Response.json({ repo: 'org/sample', prs: [{ number, headRefName: branch, state: 'OPEN' }] });
const requests = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/prs?'));
const badges = () => [...container.querySelectorAll('[title^="Pull request #"]')].map(node => node.getAttribute('title'));

async function render(paths: string[], visible = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...paths.map((repoPath, index) => createElement(BranchDetailsLauncher, {
      key: `${index}:${repoPath}`, repoPath, visible, collapsed: true, onToggleCollapsed: () => {}, workspaceId: `pane-${index}`,
    })),
  )));
  // Query observers notify on their scheduled task after the transport settles.
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  workspaces.clear();
  workspaces.set(checkout, { branch: 'feature', repoSlug: 'sample' });
  workspaces.set(otherCheckout, { branch: 'feature', repoSlug: 'sample' });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async () => list());
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('workspace branch PR lists through actual details launchers', () => {
  it('shares one list lookup across five rails for the same checkout', async () => {
    await render(Array(5).fill(checkout));
    expect(badges()).toEqual(Array(5).fill('Pull request #27'));
    expect(requests()).toHaveLength(1);
    const url = new URL(String(requests()[0][0]), 'https://fixture.invalid');
    expect(url.searchParams.get('repo')).toBe('sample');
    expect(url.searchParams.get('repoPath')).toBe(checkout);
  });

  it('reuses a fresh list on remount and resolves another branch from the same list', async () => {
    fetchMock.mockImplementation(async () => Response.json({ repo: 'org/sample', prs: [
      { number: 27, headRefName: 'feature', state: 'OPEN' }, { number: 28, headRefName: 'next', state: 'open' },
    ] }));
    await render([checkout]); await render([]);
    workspaces.set(checkout, { branch: 'next', repoSlug: 'sample' });
    await render([checkout]);
    expect(badges()).toEqual(['Pull request #28']);
    expect(requests()).toHaveLength(1);
  });

  it('isolates checkouts whose repository display names match', async () => {
    fetchMock.mockImplementation(async (url: string) => list(url.includes(encodeURIComponent(otherCheckout)) ? 81 : 27));
    await render([checkout, otherCheckout]);
    expect(badges()).toEqual(['Pull request #27', 'Pull request #81']);
    expect(requests()).toHaveLength(2);
  });

  it('does not display a delayed old-checkout result after switching scope', async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    fetchMock.mockImplementation(async () => list(81));
    await render([checkout]); await render([otherCheckout]);
    expect(badges()).toEqual(['Pull request #81']);
    await act(async () => release(list(27)));
    expect(badges()).toEqual(['Pull request #81']);
  });

  it.each(['main', 'master'])('does not fetch for the %s branch', async (branch) => {
    workspaces.set(checkout, { branch, repoSlug: 'sample' });
    await render([checkout]);
    expect(requests()).toHaveLength(0); expect(badges()).toEqual([]);
  });

  it('does not fetch for a hidden rail', async () => {
    await render([checkout], false);
    expect(requests()).toHaveLength(0); expect(badges()).toEqual([]);
  });

  it('uses the shared five-minute polling interval in a hidden window', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await render([checkout]);
    expect(badges()).toEqual(['Pull request #27']);
    await act(async () => vi.advanceTimersByTimeAsync(2 * 60_000 + 1));
    expect(requests()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(3 * 60_000));
    expect(requests()).toHaveLength(2);
  });

  it('keeps the known branch badge after a failed background refresh', async () => {
    await render([checkout]);
    fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
    await act(async () => client.invalidateQueries());
    await render([checkout]);
    expect(badges()).toEqual(['Pull request #27']);
    expect(requests()).toHaveLength(2);
  });

  it('renders no badge for a malformed list instead of failing the rail', async () => {
    fetchMock.mockImplementation(async () => Response.json({ repo: 'org/sample', prs: {} }));
    await render([checkout]);
    expect(badges()).toEqual([]);
  });
});
