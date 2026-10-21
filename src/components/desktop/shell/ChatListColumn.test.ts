// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatListColumn } from './ChatListColumn';

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
