// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrReviewGuide } from './PrReviewGuide';
import type { PrDetail } from './types';
let root: Root; let host: HTMLDivElement; let serial = 0;
const navigate = vi.fn(); const ask = vi.fn();
const detail = { number: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), files: [{ path: 'src/auth/fixture.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }], changedFiles: 1, body: '', statusCheckRollup: [] } as unknown as PrDetail;
let selection: string;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); selection = `fixture/review-${serial++}`; navigate.mockReset(); ask.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (value = detail) => act(async () => root.render(createElement(PrReviewGuide, { detail: value, selection, onNavigate: navigate, onAsk: ask })));
const open = () => act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Review guide"]')!.click());
it('restores progress, dismisses with focus, and blocks old progress after the source changes', async () => {
  await render(); await open();
  await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
  expect(host.textContent).toContain('1/4');
  await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Review guide"]'));
  await act(async () => root.render(null)); await render(); await open();
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  await render({ ...detail, headSha: 'c'.repeat(40) });
  expect(host.textContent).toContain('source changed'); expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(true);
  const update = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Update guide')!;
  await act(async () => { update.click(); update.click(); });
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false); expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
});
it('navigates existing views and prepares a question without starting inference', async () => {
  await render(); await open();
  const file = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'src/auth/fixture.ts')!;
  await act(async () => file.click()); expect(navigate).toHaveBeenCalledWith('changes', 'src/auth/fixture.ts');
  await open(); const question = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Ask about this step')!;
  await act(async () => question.click()); expect(ask).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(detail.headSha!));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
