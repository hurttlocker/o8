// @vitest-environment jsdom

import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/lib/theme/context';
import { getPalette, resolveTheme, type PaletteId, type SurfaceMode } from '@/lib/theme/registry';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
import { FloatingDialog } from '../FloatingDialog';

// Geometry adapters only; dialog focus/portal/material and theme resolution stay real.
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: { children: ReactNode; style: unknown }) => createElement('div', { style: style as HTMLAttributes<HTMLDivElement>['style'] }, children) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true, motion: { div: ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }) => createElement('div', props, children) } }));

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); onClose.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); localStorage.clear();
  for (const node of [document.documentElement, document.body]) { node.removeAttribute('style'); for (const key of ['theme', 'palette', 'surface', 'workspaceGlass']) delete node.dataset[key]; }
  document.getElementById('theme-chrome-surface')?.remove(); vi.unstubAllGlobals();
});

it.each([
  ['light', 'solid', false], ['dark', 'solid', false], ['light', 'glass', false],
  ['dark', 'glass', false], ['light', 'glass', true], ['dark', 'glass', true],
] satisfies Array<[PaletteId, SurfaceMode, boolean]>)('keeps the repository form legible and its action geometry consistent in %s/%s, All Glass %s', async (palette, surface, allGlass) => {
  localStorage.setItem('cortex-theme-palette', palette); localStorage.setItem('cortex-reduce-transparency', surface === 'solid' ? 'on' : 'off'); localStorage.setItem('cortex-workspace-glass', String(allGlass));
  await act(async () => root.render(createElement(ThemeProvider, null, createElement(ConnectRepositoryDialog, { source: 'url', projects: [], activeProjectId: null, onClose, onConnected: () => {} }))));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull(); expect(host.contains(dialog)).toBe(false);
  const material = dialog.firstElementChild as HTMLElement;
  expect(material.style.background).toBe(allGlass ? 'var(--t-glass-elevated)' : 'var(--t-popover-surface)');
  expect(material.style.backdropFilter).toBe('none');
  if (allGlass) {
    expect(dialog.style.backdropFilter).toBe('blur(24px) saturate(1.4)');
    expect(dialog.style.getPropertyValue('--t-text-secondary')).toBe('var(--t-chat-surface-text-secondary)');
  }
  expect(document.documentElement.style.getPropertyValue('--t-popover-surface')).toBe(resolveTheme(getPalette(allGlass ? 'dark' : palette), surface).cssVars['--t-popover-surface']);
  expect(material.style.overflowY).toBe('auto');
  expect(dialog.parentElement?.parentElement?.style.backdropFilter).toBe('');
  expect((dialog.parentElement?.previousElementSibling as HTMLElement).style.backdropFilter).toBe(allGlass ? '' : 'blur(6px)');
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
  const cancel = buttons.find((button) => button.textContent === 'Cancel')!; const add = buttons.find((button) => button.textContent === 'Add repository')!;
  expect(cancel.style.height).toBe(add.style.height); expect(cancel.style.borderRadius).toBe(add.style.borderRadius);
  expect(add.style.background).toBe('var(--t-accent)'); expect(add.style.color).toBe('var(--t-accent-contrast)');
  expect(add.disabled).toBe(true); expect(document.activeElement?.getAttribute('aria-label')).toBe('Repository URL');
  act(() => cancel.click()); expect(onClose).toHaveBeenCalledOnce();
});

it('includes native selects in the focus trap and returns focus to the launcher on close', async () => {
  const launcher = document.createElement('button'); document.body.append(launcher); launcher.focus();
  await act(async () => root.render(<ThemeProvider><FloatingDialog title="Choose project" onClose={onClose} overlay>
    <input aria-label="Name" /><select aria-label="Project"><option>Standalone</option></select>
  </FloatingDialog></ThemeProvider>));
  const select = document.querySelector('select')!; select.focus();
  act(() => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Name');
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(select);
  await act(async () => root.render(null)); expect(document.activeElement).toBe(launcher); launcher.remove();
});
