// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useRightPanelMaximize } from './useRightPanelMaximize';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
function Harness({ visible = true }: { visible?: boolean }) {
  const { maximized, toggleMaximized } = useRightPanelMaximize(visible);
  const [draft, setDraft] = useState('Kept draft');
  return createElement('div', null,
    createElement('button', { 'aria-label': maximized ? 'Restore panel size' : 'Maximize panel', onClick: toggleMaximized }, maximized ? 'Restore' : 'Maximize'),
    createElement('div', { 'aria-hidden': maximized, inert: maximized, style: { display: maximized ? 'none' : 'block' } }, createElement('input', { value: draft, onChange: (event) => setDraft(event.currentTarget.value) })),
  );
}
async function render(visible = true) { await act(async () => root.render(createElement(Harness, { visible }))); }
async function escape() { await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }))); }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('restores on Escape without remounting or losing the workspace draft', async () => {
  await render(); const input = host.querySelector('input');
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('[inert]')?.getAttribute('aria-hidden')).toBe('true');
  await escape(); expect(host.querySelector('[inert]')).toBeNull();
  expect(host.querySelector('input')).toBe(input); expect(input?.value).toBe('Kept draft');
  expect(document.activeElement).toBe(host.querySelector('button'));
});

it('lets an open dialog own Escape and ignores dialogs hidden by an ancestor', async () => {
  await render(); await act(async () => host.querySelector('button')!.click());
  const parent = document.createElement('div'); const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); parent.append(dialog); document.body.append(parent);
  try {
    await escape(); expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Restore panel size');
    parent.style.display = 'none'; await escape();
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Maximize panel');
  } finally { parent.remove(); }
});

it('returns to normal sizing after the side panel closes or becomes unavailable', async () => {
  await render(); await act(async () => host.querySelector('button')!.click());
  await render(false); await render(true);
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Maximize panel');
});
