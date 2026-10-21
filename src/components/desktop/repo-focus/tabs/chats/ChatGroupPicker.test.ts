// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatGroupPicker } from './ChatGroupPicker';

// Geometry only; the real picker, portal and hydration lifecycle remain mounted.
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: { children: ReactNode; style: HTMLAttributes<HTMLDivElement>['style'] }) => createElement('div', { style }, children) }));
let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host);
});
afterEach(async () => {
  await act(async () => root?.unmount()); host.remove(); root = undefined;
  vi.unstubAllGlobals();
});

it('hydrates a closed picker without a portal mismatch, then preserves repeated menu interaction', async () => {
  const onChange = vi.fn();
  const picker = createElement(ChatGroupPicker, { mode: 'chronological', onChange });
  const browserDocument = document;
  let html: string;
  try {
    vi.stubGlobal('document', undefined);
    html = renderToString(picker);
  } finally {
    vi.stubGlobal('document', browserDocument);
  }
  host.innerHTML = html!;
  const recovered: unknown[] = [];
  await act(async () => { root = hydrateRoot(host, picker, { onRecoverableError: (error) => recovered.push(error) }); });
  expect(recovered).toEqual([]);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Change chat view"]')!;
  await act(async () => trigger.click());
  let menu = document.querySelector<HTMLElement>('[aria-label="Chat view options"]')!;
  expect(menu).not.toBeNull(); expect(host.contains(menu)).toBe(false);
  expect(document.activeElement?.getAttribute('aria-checked')).toBe('true');
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  menu = document.querySelector<HTMLElement>('[aria-label="Chat view options"]')!;
  await act(async () => menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
  expect(onChange).toHaveBeenCalledWith('flat');
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
