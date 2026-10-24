// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatListColumn } from './ChatListColumn';
import { ThemeProvider } from '@/lib/theme/context';

it('retains list selection, draft and scroll through repeated collapse and responsive presentations', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  function List() {
    const [selected, setSelected] = useState('first');
    return createElement('div', { 'data-selected': selected },
      createElement('button', { onClick: () => setSelected('second') }, 'Second chat'),
      createElement('textarea', { defaultValue: '' }),
      createElement('div', { 'data-scroll': true }, 'Overflow list'),
      createElement('div', { role: 'menu' }, createElement('button', {}, 'Menu action')),
    );
  }
  const render = (visible: boolean, overlay = false, width = 320) => act(() => root.render(
    createElement(ChatListColumn, { visible, overlay, width, onClose }, createElement(List)),
  ));
  try {
    render(true);
    const aside = host.querySelector('aside')!;
    const draft = host.querySelector('textarea')!;
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    draft.value = 'Keep this unsent draft';
    scroll.scrollTop = 178;
    await act(async () => host.querySelector('button')!.click());
    for (let i = 0; i < 3; i++) {
      render(false);
      expect(aside.getAttribute('aria-hidden')).toBe('true');
      expect(aside.hasAttribute('inert')).toBe(true);
      render(true, i === 1, 384);
      expect(host.querySelector('aside')).toBe(aside);
      expect(host.querySelector('textarea')).toBe(draft);
      expect(draft.value).toBe('Keep this unsent draft');
      expect(scroll.scrollTop).toBe(178);
      expect(host.querySelector('[data-selected]')?.getAttribute('data-selected')).toBe('second');
      expect(host.querySelectorAll('textarea')).toHaveLength(1);
    }
    await act(async () => host.querySelector('[role="menu"] button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => draft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([
  ['light', 'solid', false], ['dark', 'solid', false],
  ['light', 'glass', false], ['dark', 'glass', false],
  ['light', 'glass', true], ['dark', 'glass', true],
] as const)('backs the compact overlay in %s/%s with All Glass %s without replacing the list', async (palette, surface, allGlass) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  localStorage.setItem('cortex-theme-palette', palette);
  localStorage.setItem('cortex-reduce-transparency', surface === 'solid' ? 'on' : 'off');
  localStorage.setItem('cortex-workspace-glass', String(allGlass));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const render = (overlay: boolean, visible = true) => act(async () => root.render(
    createElement(ThemeProvider, null, createElement(ChatListColumn, { visible, overlay, width: 320, onClose },
      createElement('textarea', { defaultValue: 'Unsent draft' }))),
  ));
  try {
    await render(true);
    const aside = host.querySelector('aside')!;
    const draft = host.querySelector('textarea')!;
    expect(aside.style.background).toBe('var(--t-popover-surface)');
    expect(aside.style.backdropFilter).toBe(allGlass ? 'blur(24px) saturate(1.4)' : '');
    expect(aside.style.width).toBe('320px');
    expect(aside.style.position).toBe('absolute');
    await render(true, false);
    expect(aside.style.display).toBe('none');
    expect(aside.hasAttribute('inert')).toBe(true);
    await render(false);
    expect(aside.style.background).toBe('');
    expect(aside.style.backdropFilter).toBe('');
    expect(aside.style.position).toBe('relative');
    expect(host.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('Unsent draft');
    expect(localStorage.getItem('cortex-theme-palette')).toBe(palette);
    expect(localStorage.getItem('cortex-workspace-glass')).toBe(String(allGlass));
  } finally {
    act(() => root.unmount()); host.remove(); localStorage.clear();
    for (const element of [document.documentElement, document.body]) {
      element.removeAttribute('style');
      for (const key of ['theme', 'palette', 'surface', 'workspaceGlass']) delete element.dataset[key];
    }
    document.getElementById('theme-chrome-surface')?.remove();
  }
});
