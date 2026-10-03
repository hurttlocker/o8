// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/lib/theme/context';
import { getPalette, resolveTheme, type PaletteId, type SurfaceMode } from '@/lib/theme/registry';
import { AddRepoDialog } from './AddRepoDialog';

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

function Harness() {
  const [open, setOpen] = useState(true);
  return createElement('div', { 'data-chrome-surface': 'true' },
    createElement('h1', null, 'Workspace heading behind the dialog'),
    createElement('button', { onClick: () => setOpen(true) }, 'Open repository dialog'),
    createElement(AddRepoDialog, {
      open, projects: [], activeProjectId: null,
      onClose: () => { onClose(); setOpen(false); },
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected request'));
  onClose.mockClear();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const element of [document.documentElement, document.body]) {
    element.removeAttribute('style');
    for (const key of ['theme', 'palette', 'surface', 'workspaceGlass']) delete element.dataset[key];
  }
  document.getElementById('theme-chrome-surface')?.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(palette: PaletteId = 'light', surface: SurfaceMode = 'solid', allGlass = false) {
  localStorage.setItem('cortex-theme-palette', palette);
  localStorage.setItem('cortex-reduce-transparency', surface === 'solid' ? 'on' : 'off');
  localStorage.setItem('cortex-workspace-glass', String(allGlass));
  await act(async () => root.render(createElement(ThemeProvider, null, createElement(Harness))));
}

function input() {
  const field = document.querySelector<HTMLInputElement>('#add-repo-path');
  expect(field).not.toBeNull();
  return field!;
}

function panel() {
  const modal = [...document.body.children].find((element) => element !== host && element.contains(input()));
  expect(modal).toBeInstanceOf(HTMLDivElement);
  return modal as HTMLDivElement;
}

function button(label: string) {
  const control = [...document.querySelectorAll('button')].find((element) => (
    element.textContent === label || element.getAttribute('aria-label') === label
  ));
  expect(control).toBeDefined();
  return control!;
}

async function typePath(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const appearances: Array<[PaletteId, SurfaceMode, boolean]> = [
  ['light', 'solid', false], ['dark', 'solid', false],
  ['light', 'glass', false], ['dark', 'glass', false], ['dark', 'glass', true],
];

it.each(appearances)('uses the protected overlay surface in %s/%s (All Glass: %s)', async (palette, surface, allGlass) => {
  await render(palette, surface, allGlass);
  const modal = panel();
  // The real portal must escape glass chrome, where --t-panel-solid is transparent.
  expect(host.querySelector('#add-repo-path')).toBeNull();
  expect(modal.parentElement).toBe(document.body);
  expect(modal.style.background).toBe('var(--t-panel-solid)');
  const fill = document.documentElement.style.getPropertyValue('--t-panel-solid');
  expect(fill).toBe(resolveTheme(getPalette(palette), surface).cssVars['--t-panel-solid']);
  if (surface === 'solid') {
    expect(fill).toMatch(/^#[\da-f]{6}$/i);
  } else {
    // Inspect the production gradient stops, not a copied test palette. The
    // tint itself must screen underlying text when backdrop blur does nothing.
    const alpha = [...fill.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((match) => Number(match[1]));
    expect(alpha).toHaveLength(2);
    expect(Math.min(...alpha)).toBeGreaterThanOrEqual(0.88);
  }
  if (allGlass) {
    expect(document.documentElement.dataset.workspaceGlass).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--t-panel')).toBe('transparent');
  }
  // Keep the scroll boundary; compact-width layout needs a native render.
  expect(modal.style.maxHeight).toBe('calc(100vh - 28px)');
  expect((modal.children[1] as HTMLElement).style.overflowY).toBe('auto');
  expect(button('Add').disabled).toBe(true);
  expect(input().style.color).toBe('var(--t-text)');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['Cancel', 'Close', 'Escape', 'backdrop'])('clears the form on %s and reopens without leaking a dismissal listener', async (dismissal) => {
  await render();
  await typePath('/example/repository');
  input().focus();
  expect(document.activeElement).toBe(input());
  expect(button('Scan').disabled).toBe(false);
  await act(async () => input().click());
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => {
    if (dismissal === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    else if (dismissal === 'backdrop') (panel().previousElementSibling as HTMLElement).click();
    else button(dismissal).click();
  });
  expect(document.querySelector('#add-repo-path')).toBeNull();
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => button('Open repository dialog').click());
  expect(input().value).toBe('');
  expect(button('Add').disabled).toBe(true);
  expect(panel().style.background).toBe('var(--t-panel-solid)');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('keeps the shared surface through validation, error recovery, and the busy add state', async () => {
  let finishValidation!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishValidation = resolve; }));
  await render();
  await typePath('/example/repository');
  await act(async () => button('Scan').click());
  expect(button('Scan').disabled).toBe(true);
  expect(button('Browse').disabled).toBe(true);
  expect(button('Add').disabled).toBe(true);
  expect(panel().style.background).toBe('var(--t-panel-solid)');
  await act(async () => finishValidation(Response.json({ error: 'Folder is unavailable' }, { status: 400 })));
  expect(panel().textContent).toContain('Folder is unavailable');
  expect(button('Add').disabled).toBe(true);
  await typePath('/example/another-repository');
  expect(panel().textContent).not.toContain('Folder is unavailable');
  expect(button('Add').disabled).toBe(false);

  let finishAdd!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishAdd = resolve; }));
  await act(async () => button('Add').click());
  expect(button('Adding…').disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(true);
  expect(input().disabled).toBe(true);
  expect(panel().style.background).toBe('var(--t-panel-solid)');
  await act(async () => finishAdd(Response.json({ error: 'Folder is unavailable' }, { status: 400 })));
  expect(button('Cancel').disabled).toBe(false);
  expect(input().disabled).toBe(false);
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).action)).toEqual(['validate', 'validate']);
  expect(onClose).not.toHaveBeenCalled();
});
