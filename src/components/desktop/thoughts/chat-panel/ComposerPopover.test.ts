// @vitest-environment jsdom

import { act, createElement } from 'react';
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
