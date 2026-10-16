// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrBrainComposer } from './PrBrainComposer';
import type { PrDetail } from './types';
vi.mock('@/lib/analytics/track', () => ({ track: vi.fn() }));
const detail: PrDetail = { number: 17, title: 'Selected change', body: 'The description', state: 'open', author: 'author', headRefName: 'work', baseRefName: 'main', headSha: 'revision-17', baseSha: 'base-17', additions: 1, deletions: 1, changedFiles: 1, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: false, reviewDecision: null, statusCheckRollup: [], url: 'https://github.com/example/repo/pull/17', files: [{ path: 'app.ts', status: 'modified', additions: 1, deletions: 1, patch: 'private-patch' }], reviewComments: [], issueComments: [] };
let root: Root; let host: HTMLDivElement; let finish: (() => void) | null;
function Fixture() { const [draft, onDraftChange] = useState(''); return createElement(PrBrainComposer, { detail, repoSlug: 'example/repo', repoPath: '/workspace/repo', draft, onDraftChange }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  finish = null;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"Synthetic answer"}\n\n')); controller.close(); }; } }))));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('pull request Brain handoff', () => {
  it('sends only on submission, scopes the snapshot, expands one in-place chat and respects collapse before a late answer', async () => {
    await act(async () => root.render(createElement(Fixture)));
    expect(fetch).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull();
    const input = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'What changed?');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    });
    await act(async () => { const form = host.querySelector('form')!; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/cortex/ask');
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.repoPath).toBe('/workspace/repo'); expect(body.question).toContain('What changed?'); expect(body.question).toContain('example/repo'); expect(body.question).toContain('revision-17'); expect(body.question).toContain('patchesIncluded'); expect(body.question).not.toContain('private-patch');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0); expect(host.querySelector('[data-pr-brain-chat]')?.getAttribute('data-expanded')).toBe('true'); expect(document.body.textContent).toContain('What changed?'); expect(input.value).toBe('');
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === 'Collapse PR conversation')!.click());
    expect(host.querySelector('[data-pr-brain-chat]')?.getAttribute('data-expanded')).toBe('false');
    await act(async () => finish!());
    expect(host.querySelector('[data-pr-brain-chat]')?.getAttribute('data-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(input);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open Brain conversation for PR #17"]')!.click());
    expect(document.body.textContent).toContain('Synthetic answer');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-pr-brain-chat]')?.getAttribute('data-expanded')).toBe('false');
    await act(async () => root.render(createElement(Fixture))); expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'And why?'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fetch).toHaveBeenCalledTimes(2);
    const followup = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(followup.question).toContain('And why?'); expect(followup.question).toContain('Synthetic answer'); expect(followup.question).toContain('What changed?');
    await act(async () => finish!());

  });
});
