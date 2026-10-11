// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrPanelActions } from './PrPanelActions';
import type { PrDetail } from './types';

let host: HTMLDivElement; let root: Root; let fetchMock: ReturnType<typeof vi.fn>;
const sha = 'a'.repeat(40);
const detail = (number: number, headSha = sha): PrDetail => ({ number, headSha, resolvedRepo: 'example/repo', title: 'Change', body: '', state: 'open', author: 'author', headRefName: 'work', baseRefName: 'main', additions: 1, deletions: 1, changedFiles: 0, createdAt: '', updatedAt: '', closedAt: null, mergedAt: null, mergeable: true, reviewDecision: null, statusCheckRollup: [], url: `https://github.com/example/repo/pull/${number}`, files: [], reviewComments: [], issueComments: [] });
const render = (value: PrDetail) => act(async () => root.render(createElement(PrPanelActions, { key: String(value.number), detail: value, repoPath: '/workspace/repo', onRefresh: vi.fn(), onAsk: vi.fn(), onComposerMode: vi.fn() })));
const click = async (label: string) => act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.getAttribute('aria-label') === label || button.textContent === label)!.click());
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal('fetch', fetchMock); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
describe('PR action entry points', () => {
  it('keeps menu opening read-only and contains keyboard focus with Escape returning to the trigger', async () => {
    await render(detail(9811)); await click('Pull request actions');
    expect(document.activeElement?.textContent).toBe('Ask Brain');
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Close pull request');
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Pull request actions'); expect(host.querySelector('[role=menu]')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation and rejects a newer head before sending', async () => {
    await render(detail(9812)); await click('Merge pull request'); await click('Squash and merge');
    expect(host.querySelector('[role=dialog]')).not.toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    await render(detail(9812, 'b'.repeat(40)));
    expect(host.textContent).toContain('pull request changed'); expect(Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Squash and merge')?.disabled).toBe(true);
    await click('Cancel'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['Merge', 'Squash and merge', 'Rebase and merge'])('sends %s only after confirmation with the selected commit and method', async (label) => {
    const number = 9820 + ['Merge', 'Squash and merge', 'Rebase and merge'].indexOf(label);
    await render(detail(number)); await click('Merge pull request'); await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role=menu] button')).find((button) => button.textContent === label)!.click()); expect(fetchMock).not.toHaveBeenCalled(); await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role=dialog] button')).find((button) => button.textContent === label)!.click());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ repo: 'example/repo', action: 'merge', commitSha: sha, mergeMethod: label === 'Merge' ? 'merge' : label === 'Squash and merge' ? 'squash' : 'rebase' });
  });
  it('offers the manual checkout command without advertising or requesting workspace creation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await render(detail(9831)); await click('Check out pull request');
    expect(host.textContent).not.toContain('Create review workspace');
    expect(host.textContent).not.toContain('Copy workspace path');
    expect(host.querySelector('[role=dialog]')).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
    await click('Copy checkout command');
    expect(writeText).toHaveBeenCalledWith('gh pr checkout 9831 --repo example/repo');
    expect(fetchMock).not.toHaveBeenCalled();
    await render(detail(9832)); await click('Pull request actions');
    expect(host.textContent).toContain('Submit a review'); expect(host.textContent).toContain('Discuss review findings');
    expect(fetchMock).not.toHaveBeenCalled(); expect(host.querySelector('[role=dialog]')).toBeNull();
  });
});
