// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyUiZoom, clearUiZoom } from '@/lib/appearance/ui-zoom';
import { ComposerPopover } from './ComposerPopover';

let root: Root;
let host: HTMLDivElement;
let anchor: HTMLButtonElement;
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
  host = document.createElement('div');
  anchor = document.createElement('button');
  document.body.append(host, anchor);
  root = createRoot(host);
  onClose.mockClear();
  anchor.getBoundingClientRect = () => {
    const zoom = Number(document.documentElement.style.getPropertyValue('--ui-zoom')) || 1;
    return { left: 700 * zoom, right: 780 * zoom, top: 600 * zoom, bottom: 622 * zoom,
      width: 80 * zoom, height: 22 * zoom, x: 700 * zoom, y: 600 * zoom, toJSON: () => ({}) };
  };
});

describe('composer popover keyboard entry', () => {
  function Menu({ onReady }: { onReady?: () => void }) {
    const [open, setOpen] = useState(true);
    const props = { anchorRef: { current: anchor }, open, onClose: () => setOpen(false), onOpenReady: onReady,
      children: createElement('div', { role: 'menu' },
        createElement('button', { role: 'menuitemradio', 'aria-checked': false, onClick: () => setOpen(false) }, 'Solo'),
        createElement('button', { role: 'menuitemradio', disabled: true }, 'Unavailable'),
        createElement('button', { role: 'menuitemradio', 'aria-checked': true }, 'Shared'),
        createElement('button', { role: 'menuitemradio', 'aria-checked': false }, 'Multitask'),
      ) };
    return createElement(ComposerPopover, props);
  }

  it('focuses the selected mode, skips disabled choices, and returns to its trigger on Escape', async () => {
    anchor.focus();
    await act(async () => root.render(createElement(Menu)));
    expect(document.activeElement?.textContent).toBe('Shared');
    for (const [key, expected] of [['ArrowUp', 'Solo'], ['ArrowUp', 'Multitask'], ['Home', 'Solo'], ['End', 'Multitask']]) {
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      expect(document.activeElement?.textContent).toBe(expected);
    }
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('preserves a custom opening focus and outside pointer focus', async () => {
    const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => root.render(createElement(Menu, { onReady: () => document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus() })));
    expect(document.activeElement?.textContent).toBe('Solo');
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      outside.focus();
    });
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('returns focus after choosing a menu item', async () => {
    anchor.focus();
    await act(async () => root.render(createElement(Menu)));
    const choice = document.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!;
    await act(async () => { choice.focus(); choice.click(); });
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('restores focus on repeated open and close journeys', async () => {
    const anchorRef = { current: anchor };
    const render = async (open: boolean) => {
      const props = { anchorRef, open, onClose, children: createElement('button', null, 'Choice') };
      await act(async () => root.render(createElement(ComposerPopover, props)));
    };
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await render(true);
      expect(document.activeElement?.textContent).toBe('Choice');
      await render(false);
      expect(document.activeElement).toBe(anchor);
    }
  });

  it('focuses search first and leaves text-editing arrow keys alone', async () => {
    const props = { anchorRef: { current: anchor }, open: true, onClose,
      children: createElement('div', { role: 'menu' }, createElement('input', { placeholder: 'Search models' }), createElement('button', { role: 'menuitem' }, 'Model')) };
    await act(async () => root.render(createElement(ComposerPopover, props)));
    expect(document.activeElement?.getAttribute('placeholder')).toBe('Search models');
    const event = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  anchor.remove();
  clearUiZoom();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountPopover() {
  const props = {
    anchorRef: { current: anchor }, open: true, onClose,
    children: createElement('button', { onKeyDown: (event) => event.preventDefault() }, 'Handled control'),
  };
  await act(async () => root.render(createElement(ComposerPopover, props)));
  return document.querySelector<HTMLDivElement>('[data-composer-overlay]')!;
}

describe('composer popover positioning', () => {
  it.each([0.8, 1.25])('anchors in document coordinates at zoom %s', async (zoom) => {
    applyUiZoom(zoom);
    const panel = await mountPopover();
    expect(Number.parseFloat(panel.style.left)).toBeCloseTo(480);
    expect(Number.parseFloat(panel.style.top)).toBeCloseTo(392);
  });

  it('repositions an open menu when root zoom changes without a resize event', async () => {
    const panel = await mountPopover();
    const viewportBounds = anchor.getBoundingClientRect();
    anchor.getBoundingClientRect = () => viewportBounds;
    await act(async () => { applyUiZoom(1.25); });
    expect(Number.parseFloat(panel.style.left)).toBeCloseTo(324);
    expect(Number.parseFloat(panel.style.top)).toBeCloseTo(272);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets the active control handle Escape before dismissing the whole menu', async () => {
    const panel = await mountPopover();
    await act(async () => panel.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    })));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
