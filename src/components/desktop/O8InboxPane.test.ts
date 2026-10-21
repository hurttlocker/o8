// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintainerFeed, MaintainerContribution } from '@/lib/inbox/maintainer-types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { O8InboxPane } from './O8InboxPane';

const repos = [{ localPath: '/workspace/one', name: 'one' }, { localPath: '/workspace/two', name: 'two' }] as RepoRegistryEntry[];
const reply = (number: number, repoPath: string, date: string): MaintainerContribution => ({ id: `reply:${number}`, kind: 'reply', repo: `example/repo${number}`, repoPaths: [repoPath], number, title: `Waiting thread ${number}`, author: 'contributor', assignees: [], url: `https://github.com/example/repo${number}/issues/${number}`, createdAt: date, updatedAt: date, waitingSince: date, threadKind: 'issue' });
const feed: MaintainerFeed = { replies: [reply(1, '/workspace/one', '2026-10-01T10:00:00Z'), reply(2, '/workspace/two', '2026-10-02T10:00:00Z'), reply(3, '/elsewhere', '2026-10-03T10:00:00Z')], contributions: [], sources: [{ repo: 'example/repo1', repoPaths: ['/workspace/one'], stale: true, lastSuccessfulAt: '2026-10-01T10:00:00Z' }], truncated: false, repliesTruncated: false };
let host: HTMLDivElement; let root: Root; let fetchMock: ReturnType<typeof vi.fn>;
const render = (repoPath = '/workspace/one', active = true) => act(async () => root.render(createElement(O8InboxPane, { repoPath, repos, active })));
const tab = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent?.startsWith(label))!;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(async (url: string) => url.startsWith('/api/panel/approvals') ? Response.json({ approvals: [] }) : Response.json({ items: [], maintainer: feed }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('maintainer inbox navigation', () => {
  it('shows scoped replies oldest first, uses keyboard scopes, and keeps approvals global', async () => {
    await render();
    expect(Array.from(host.querySelectorAll('[data-maintainer-thread]')).map((card) => card.getAttribute('data-maintainer-thread'))).toEqual(['reply:1', 'reply:2']);
    expect(host.textContent).toContain('Cached GitHub data');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inbox scope"]')!.click());
    const choice = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!;
    await act(async () => choice.click());
    expect(host.querySelectorAll('[data-maintainer-thread]')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/panel/supervisor-inbox')).at(-1)?.[0]).toContain('maintainerRepoPath=%2Fworkspace%2Fone');
    await act(async () => tab('Approvals').click());
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Inbox scope"]')!.disabled).toBe(true);
    expect(host.textContent).toContain('Approvals across all workspaces');
    await act(async () => tab('Approvals').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(tab('Needs reply').getAttribute('aria-selected')).toBe('true');
  });
  it('does not show a false clean state when GitHub data or approvals fail', async () => {
    fetchMock.mockImplementation(async (url: string) => url.startsWith('/api/panel/approvals') ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json({ items: [], maintainer: null, maintainerError: 'GitHub data is unavailable' }));
    await render(); expect(host.textContent).toContain('GitHub data is unavailable'); expect(host.textContent).not.toContain('No unanswered');
    await act(async () => tab('Approvals').click());
    expect(host.textContent).toContain('Approvals could not be refreshed'); expect(host.textContent).not.toContain('No pending approvals');
  });
  it('closes a scope menu on leaving and ignores old scope data until the latest read finishes', async () => {
    await render(); await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inbox scope"]')!.click());
    await render('/workspace/one', false); expect(document.querySelector('[aria-label="Inbox scope"][role="menu"]')).toBeNull();
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inbox scope"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh inbox"]')!.click());
    await render('/workspace/two');
    await act(async () => finish(Response.json({ items: [], maintainer: { ...feed, replies: [reply(9, '/workspace/two', '2026-10-04T10:00:00Z')] } })));
    expect(host.textContent).not.toContain('Waiting thread 9');
    expect(host.textContent).toContain('Waiting thread 2');
  });
});
