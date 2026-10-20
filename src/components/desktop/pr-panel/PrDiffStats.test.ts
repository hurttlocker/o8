// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrDiffStats } from './PrDiffStats';
vi.mock('../FloatingSurface', () => ({ FloatingSurface: ({ children, contentStyle: _contentStyle, ...props }: Record<string, unknown>) => createElement('div', props, children as import('react').ReactNode) }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function render(totalFiles = 2) {
  await act(async () => root.render(createElement(PrDiffStats, { files: [{ path: 'main.ts', additions: 10, deletions: 2 }, { path: 'main.test.ts', additions: 4, deletions: 0 }], totalFiles, additions: 14, deletions: 2 })));
  return host.querySelector('button')!;
}
it('opens on keyboard focus, dismisses with Escape and does not add a native tooltip', async () => {
  const button = await render(); await act(async () => button.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Tests');
  expect(button.hasAttribute('title')).toBe(false);
  await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull(); expect(document.activeElement).toBe(button);
  await act(async () => button.click()); expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => button.click()); expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it('keeps a hovered card open across the trigger gap, closes outside and cleans up on unmount', async () => {
  vi.useFakeTimers(); const button = await render();
  await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () => vi.advanceTimersByTime(240));
  const card = document.querySelector('[role="tooltip"]')!; expect(card).not.toBeNull();
  await act(async () => { button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); vi.advanceTimersByTime(250); });
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => button.click()); await act(async () => root.render(null));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it('labels partial metadata separately from the authoritative PR total', async () => {
  const button = await render(101); await act(async () => button.click());
  const card = document.querySelector('[role="tooltip"]')!;
  expect(card.textContent).toContain('2 of 101 files loaded');
  expect(card.textContent).toContain('Loaded files'); expect(card.textContent).toContain('PR total');
});
