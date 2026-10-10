// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { LinkedPullRequests } from './LinkedPullRequests';
import { readLinkedPullRequests } from './linked-pr-store';

vi.mock('../FloatingDialog', () => ({ FloatingDialog: ({ children, title }: { children: React.ReactNode; title: string }) => createElement('div', { role: 'dialog', 'aria-label': title }, children) }));
const repos = [{ id: 'repo', name: 'repo', localPath: '/workspace/repo', remoteUrl: 'https://github.com/example/repo.git' }] as RepoRegistryEntry[];
let host: HTMLDivElement; let root: Root; let fetchMock: ReturnType<typeof vi.fn>;
const render = (context = 'tab:one', tabId: string | null = 'one', active = true) => act(async () => root.render(createElement(LinkedPullRequests, { context, tabId, active, repoPath: '/workspace/repo', repos })));
const click = (text: string) => act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === text)!.click());
async function submit(value = '#17') {
  await click('Link PR');
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  fetchMock = vi.fn(async (url: string) => url.includes('/api/panel/prs/17?')
    ? Response.json({ pr: { number: 17, title: 'Improve the extension flow', resolvedRepo: 'example/repo' } })
    : Response.json({ repo: 'example/repo', prs: [], nextPage: null }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('conversation-linked PR entry point', () => {
  it('verifies a PR, saves it, deduplicates it, and restores it after remounting', async () => {
    await render(); expect(fetchMock).not.toHaveBeenCalled();
    await submit();
    expect(readLinkedPullRequests('tab:one').map((entry) => entry.number)).toEqual([17]);
    await submit('https://github.com/EXAMPLE/REPO/pull/17');
    expect(readLinkedPullRequests('tab:one')).toHaveLength(1);
    await act(async () => root.unmount()); root = createRoot(host); await render();
    expect(host.textContent).toContain('#17 · Improve the extension flow');
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Unlink PR #17 in example/repo"]')!.click());
    expect(readLinkedPullRequests('tab:one')).toHaveLength(0);
  });
  it('moves fresh-tab links into its history conversation without leaking them into another tab', async () => {
    await render(); await submit(); await render('thread:saved', 'one');
    expect(readLinkedPullRequests('thread:saved')).toHaveLength(1);
    await render('thread:other', 'two');
    expect(host.textContent).not.toContain('#17'); expect(readLinkedPullRequests('thread:other')).toHaveLength(0);
    await render('thread:saved', 'three'); expect(host.textContent).toContain('#17');
  });
  it('does not save an unverified repository, failed request, or response for a conversation that was left', async () => {
    await render(); await submit('https://github.com/unconnected/repo/pull/17');
    expect(fetchMock).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Connect this repository');
    await click('Cancel'); fetchMock.mockResolvedValueOnce(Response.json({ pr: { number: 17, title: 'Wrong repository', resolvedRepo: 'example/other' } }));
    await submit(); expect(readLinkedPullRequests('tab:one')).toHaveLength(0);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be verified'); await click('Cancel');
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    await submit(); await render('tab:two', 'two');
    await act(async () => finish(Response.json({ pr: { number: 17, title: 'Late response', resolvedRepo: 'example/repo' } })));
    expect(readLinkedPullRequests('tab:one')).toHaveLength(0); expect(readLinkedPullRequests('tab:two')).toHaveLength(0);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it('closes the transient linking dialog while hidden and reports a storage failure', async () => {
    await render(); await click('Link PR'); await render('tab:one', 'one', false);
    expect(host.querySelector('[role="dialog"]')).toBeNull(); await render();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    await submit(); expect(host.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable');
    expect(readLinkedPullRequests('tab:one')).toHaveLength(0);
  });
});
