// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildLinkedIssueContext, IssueLinkPickerModal } from './IssueLinkPicker';

let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
const select = vi.fn();
const close = vi.fn();
const clear = vi.fn();
const repos = [{ name: 'Sample', remoteUrl: 'https://github.com/org/sample' },
  { name: 'Other', remoteUrl: 'git@github.com:org/other.git' }];
const issue = (number = 7, title = 'Repair fixture', state = 'OPEN') => ({
  number, title, state, body: 'Issue context for the composer.', url: `https://github.com/org/sample/issues/${number}`,
});
const list = (number = 7, title = 'Repair fixture') => Response.json({ issues: [issue(number, title), issue(8, 'Closed fixture', 'CLOSED')] });
const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/panel/issues?'));
async function settle(ms = 0) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }
async function render(count = 1, open = true) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    ...Array.from({ length: count }, (_, key) => createElement(IssueLinkPickerModal, {
      key, open, onSelect: select, onClose: close, onClear: clear,
      value: { repo: 'org/sample', ...issue() },
    })),
  ))); await settle(); await settle();
}
async function changeRepo(slug: string) {
  await act(async () => {
    const input = host.querySelector('select')!;
    input.value = slug;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }); await settle();
}
const issueButton = (number: number) => [...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(`#${number}`));

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  select.mockClear(); close.mockClear(); clear.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchMock = vi.fn(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos }) : list());
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it('shares one list read across five mounted issue pickers', async () => {
  await render(5);
  expect(host.textContent?.match(/Repair fixture/g)).toHaveLength(5);
  expect(reads()).toHaveLength(1);
});
it('reuses the fresh issue list on reopen and remount', async () => {
  await render(); await render(1, false); await render(); await render(0); await render();
  expect(issueButton(7)).toBeDefined(); expect(reads()).toHaveLength(1);
});
it('does not read lists while closed or without a selected repository', async () => {
  await render(1, false); expect(reads()).toHaveLength(0);
  fetchMock.mockImplementation(async () => Response.json({ repos: [] }));
  // A fresh picker without a linked issue has no fallback repository.
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(IssueLinkPickerModal, { open: true, onSelect: select, onClose: close }),
  ))); await settle(); await settle();
  expect(reads()).toHaveLength(0); expect(host.textContent).toContain('No repos available');
});
it('filters closed issues and preserves search, selection and composer context', async () => {
  await render(); expect(issueButton(8)).toBeUndefined();
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(issueButton(7)).toBeUndefined();
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '7');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => issueButton(7)!.click());
  expect(select).toHaveBeenCalledWith({ repo: 'org/sample', number: 7, title: 'Repair fixture',
    body: 'Issue context for the composer.', url: 'https://github.com/org/sample/issues/7' });
  expect(close).toHaveBeenCalledOnce();
  expect(buildLinkedIssueContext(select.mock.calls[0][0])).toContain('Linked GitHub issue #7 in org/sample: Repair fixture.');
  expect(buildLinkedIssueContext(select.mock.calls[0][0])).toContain('Issue context for the composer.');
});
it('isolates repository changes and ignores a delayed old repository reply', async () => {
  let release!: () => void;
  fetchMock.mockImplementation((url: string) => url === '/api/panel/repos' ? Promise.resolve(Response.json({ repos }))
    : url.includes(encodeURIComponent('org/sample')) ? new Promise<Response>(resolve => { release = () => resolve(list()); })
    : Promise.resolve(list(9, 'Other repository issue')));
  await render(); await changeRepo('org/other');
  expect(issueButton(9)).toBeDefined(); expect(issueButton(7)).toBeUndefined();
  await act(async () => release()); await settle();
  expect(issueButton(7)).toBeUndefined();
  await act(async () => issueButton(9)!.click());
  expect(select.mock.calls[0][0]).toMatchObject({ repo: 'org/other', number: 9, title: 'Other repository issue' });
});
it('removes old repository options immediately while the next list is pending', async () => {
  await render();
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  await changeRepo('org/other');
  expect(issueButton(7)).toBeUndefined(); expect(host.textContent).toContain('Loading issues');
});
it('refreshes visible issues at two minutes and stops polling after close', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await render(); fetchMock.mockImplementation(async () => list(9, 'Updated issue'));
  await settle(2 * 60_000 + 1); await settle();
  expect(issueButton(9)).toBeDefined(); expect(reads()).toHaveLength(2);
  await render(1, false); await settle(5 * 60_000);
  expect(reads()).toHaveLength(2); expect(host.textContent).toBe('');
});
it('uses the shared five-minute refresh interval while hidden', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await render(); await settle(2 * 60_000 + 1); expect(reads()).toHaveLength(1);
  await settle(3 * 60_000); expect(reads()).toHaveLength(2);
});
it('retains selectable known issues after a rate-limited refresh', async () => {
  await render(); fetchMock.mockImplementation(async () => new Response('rate limited', { status: 429 }));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(reads()).toHaveLength(2); expect(issueButton(7)).toBeDefined();
  await act(async () => issueButton(7)!.click()); expect(select.mock.calls[0][0].repo).toBe('org/sample');
});
it.each([{}, { issues: null }, { issues: {} }])('retains selectable issues after a malformed successful refresh: %j', async payload => {
  await render(); fetchMock.mockImplementation(async () => Response.json(payload));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(issueButton(7)).toBeDefined();
  expect(client.getQueryState(['gh', 'org/sample', 'issues'])?.status).toBe('error');
  await act(async () => issueButton(7)!.click());
  expect(select.mock.calls[0][0]).toMatchObject({ repo: 'org/sample', number: 7 });
});
it('accepts valid stale issue snapshots and subsequent empty lists', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos })
    : Response.json({ issues: [issue()], stale: true, error: 'Refresh unavailable' }));
  await render(); expect(issueButton(7)).toBeDefined();
  expect(client.getQueryData(['gh', 'org/sample', 'issues'])).toMatchObject({ stale: true, error: 'Refresh unavailable' });
  fetchMock.mockImplementation(async () => Response.json({ issues: [] }));
  await act(async () => { await client.invalidateQueries(); }); await settle();
  expect(issueButton(7)).toBeUndefined();
  expect(client.getQueryState(['gh', 'org/sample', 'issues'])?.status).toBe('success');
});
it('reports an initial failure and retries on the next opening', async () => {
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos })
    : new Response('unavailable', { status: 503 }));
  await render(); expect(host.textContent).toContain('Unable to load GitHub issues for this repository.');
  expect(issueButton(7)).toBeUndefined();
  fetchMock.mockImplementation(async (url: string) => url === '/api/panel/repos' ? Response.json({ repos }) : list());
  await render(1, false); await render(); expect(issueButton(7)).toBeDefined(); expect(reads()).toHaveLength(2);
});
it('keeps registry errors and clear-link actions available', async () => {
  fetchMock.mockRejectedValue(new Error('unavailable'));
  await render(); expect(host.textContent).toContain('Unable to load registered repositories.');
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === 'Clear link')!;
  await act(async () => button.click()); expect(clear).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
