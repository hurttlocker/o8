// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrBrainComposer } from './PrBrainComposer';
import type { PrComposerMode, PrDetail, PrReviewAction } from './types';

vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));
const base: PrDetail = { number: 9917, title: 'Scoped change', body: '', state: 'open', author: 'author', headRefName: 'work', headSha: 'a'.repeat(40), baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, statusCheckRollup: [], url: 'https://github.com/example/repo/pull/9917', files: [], reviewComments: [], issueComments: [] };
let root: Root; let host: HTMLDivElement;
function Fixture({ number = 9917, headSha = base.headSha }: { number?: number; headSha?: string }) {
  const [draft, onDraftChange] = useState(''); const [commentDraft, onCommentDraftChange] = useState(''); const [mode, setMode] = useState<PrComposerMode>('brain');
  const [reviewDraft, onReviewDraftChange] = useState(''); const [reviewAction, onReviewActionChange] = useState<PrReviewAction>('review-comment'); const [reviewHeadSha, setReviewHead] = useState('');
  return createElement(PrBrainComposer, { detail: { ...base, number, headSha }, repoSlug: 'example/repo', repoPath: '/workspace/repo', draft, onDraftChange, mode, reviewDraft, onReviewDraftChange, reviewAction, onReviewActionChange, reviewHeadSha, onReviewHeadChange: () => setReviewHead(headSha || ''), commentDraft, onCommentDraftChange, onModeChange: (next, command) => { setMode(next); if (next === 'review' && !reviewHeadSha) setReviewHead(headSha || ''); if (command !== undefined) { if (command) (next === 'review' ? onReviewDraftChange : onCommentDraftChange)(command); onDraftChange(''); } } });
}
async function type(selector: string, value: string) { await act(async () => { const input = host.querySelector<HTMLTextAreaElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('PR comment mode', () => {
  it('switches on /comment without sending, requires explicit Post, deduplicates clicks and keeps a newer draft', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(() => pending));
    await act(async () => root.render(createElement(Fixture)));
    await type('[data-pr-question]', '/comment First comment');
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment]')?.value).toBe('First comment');
    expect(host.textContent).toContain('Posts to example/repo · PR #9917 on GitHub.');
    await act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/panel/prs/9917'); expect(JSON.parse(String(init?.body))).toEqual({ action: 'comment', repo: 'example/repo', comment: 'First comment' });
    await type('[data-pr-comment]', 'A newer draft');
    await act(async () => finish(Response.json({ ok: true })));
    expect(host.textContent).toContain('Comment posted.'); expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment]')?.value).toBe('A newer draft');
    await act(async () => host.querySelector<HTMLElement>('button[aria-label="Switch to Brain"]')!.click());
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-question]')?.value).toBe(''); expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('preserves a failed draft, locks uncertain delivery and waits for an explicit acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection lost')));
    await act(async () => root.render(createElement(Fixture, { number: 9918 })));
    await type('[data-pr-question]', '/comment Keep this draft');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Check this pull request on GitHub');
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment]')?.value).toBe('Keep this draft');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === "I've checked GitHub")!.click());
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false); expect(fetch).toHaveBeenCalledOnce();
  });
});


describe('PR command drawer and review', () => {
  it('offers commands on slash, contains Escape, and selects Review with keys without sending', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await act(async () => root.render(createElement(Fixture, { number: 9921 })));
    await type('[data-pr-question]', '/');
    const input = host.querySelector<HTMLTextAreaElement>('[data-pr-question]')!;
    expect(input.getAttribute('aria-controls')).toBe(host.querySelector('[role="listbox"]')?.id);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(input.value).toBe('/'); expect(fetch).not.toHaveBeenCalled();
    await type('[data-pr-question]', '/r');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(host.querySelector('[data-pr-review]')).not.toBeNull(); expect(document.activeElement).toBe(host.querySelector('[data-pr-review]')); expect(fetch).not.toHaveBeenCalled();
  });
  it('blocks a review of a newer commit until acknowledged and submits the selected outcome with its commit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true })));
    await act(async () => root.render(createElement(Fixture, { number: 9922 })));
    await type('[data-pr-question]', '/review Please add coverage');
    await act(async () => root.render(createElement(Fixture, { number: 9922, headSha: 'b'.repeat(40) })));
    expect(host.textContent).toContain('newer commit'); expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Use latest commit')!.click());
    const requestChanges = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) => button.textContent === 'Request changes')!;
    await act(async () => requestChanges.click());
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ action: 'request-changes', repo: 'example/repo', comment: 'Please add coverage', commitSha: 'b'.repeat(40) });
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-review]')?.value).toBe(''); expect(host.textContent).toContain('Changes requested.');
  });
  it('retries only close after partial delivery and clears the confirmed comment draft', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ok: false, commentPosted: true }, { status: 502 })).mockResolvedValueOnce(Response.json({ ok: true })); vi.stubGlobal('fetch', fetchMock);
    await act(async () => root.render(createElement(Fixture, { number: 9923 })));
    await type('[data-pr-question]', '/comment Done');
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Close with comment')!.click());
    expect(host.querySelector<HTMLTextAreaElement>('[data-pr-comment]')?.value).toBe('');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry close')!.click());
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).action)).toEqual(['close-with-comment', 'close']);
    expect(host.textContent).toContain('Pull request closed.');
  });
});
