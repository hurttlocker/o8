// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSessionToLayout, collectSessionLeaves, createDefaultSessionTileLayout } from '@/lib/orchestrator/session-tiles';
import { projectResponsiveAutomaticSessionTiles } from '@/lib/orchestrator/session-tile-responsive';
import { THREAD_DRAG_CANCEL_EVENT, THREAD_DRAG_END_EVENT, THREAD_DRAG_MOVE_EVENT, THREAD_DRAG_START_EVENT } from '@/lib/workspace-terminal/thread-drag';
import { ThreadDropLayer } from './ThreadDropLayer';

function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

describe('ThreadDropLayer compact worker targets', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('drops onto the worker at its scrolled visible position, not its unscrolled tree position', async () => {
    const source = Array.from({ length: 10 }, (_, index) => `worker:${index + 1}`)
      .reduce((layout, key) => addSessionToLayout(layout, key), createDefaultSessionTileLayout());
    const worker = collectSessionLeaves(source.root).at(-1)!;
    const layout = projectResponsiveAutomaticSessionTiles(source, 'balanced');
    const onDrop = vi.fn();

    await act(async () => {
      root.render(createElement('div', null,
        createElement('div', { 'data-session-tile-surface': 'true' },
          createElement('div', { 'data-session-tile-leaf-id': worker.id })),
        createElement(ThreadDropLayer, { active: true, layout, onDrop, useRenderedLeafRects: true }),
      ));
    });

    const overlay = host.querySelector<HTMLElement>('[data-thread-drop-layer]')!;
    const pane = host.querySelector<HTMLElement>('[data-session-tile-leaf-id]')!;
    overlay.getBoundingClientRect = () => box(0, 0, 1000, 800);
    pane.getBoundingClientRect = () => box(700, 200, 280, 240);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(THREAD_DRAG_START_EVENT, {
        detail: {
          payload: { threadId: 'thread:one', title: 'One', mode: 'orchestrator' },
          clientX: 800,
          clientY: 220,
        },
      }));
      window.dispatchEvent(new CustomEvent(THREAD_DRAG_END_EVENT, {
        detail: { clientX: 800, clientY: 220 },
      }));
    });

    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'replace',
      leafId: worker.id,
      thread: expect.objectContaining({ threadId: 'thread:one' }),
    }));
  });

  it('updates the same pane and zone when its rendered bounds move', async () => {
    const source = Array.from({ length: 10 }, (_, index) => `worker:${index + 1}`)
      .reduce((layout, key) => addSessionToLayout(layout, key), createDefaultSessionTileLayout());
    const worker = collectSessionLeaves(source.root)[0]!;
    await act(async () => root.render(createElement('div', null,
      createElement('div', { 'data-session-tile-surface': 'true' },
        createElement('div', { 'data-session-tile-leaf-id': worker.id })),
      createElement(ThreadDropLayer, { active: true, layout: projectResponsiveAutomaticSessionTiles(source, 'balanced'), onDrop: vi.fn(), useRenderedLeafRects: true }),
    )));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const overlay = host.querySelector<HTMLElement>('[data-thread-drop-layer]')!;
    const pane = host.querySelector<HTMLElement>('[data-session-tile-leaf-id]')!;
    overlay.getBoundingClientRect = () => box(0, 0, 1000, 800);
    let top = 200;
    pane.getBoundingClientRect = () => box(700, top, 280, 240);
    await act(async () => window.dispatchEvent(new CustomEvent(THREAD_DRAG_START_EVENT, {
      detail: { payload: { threadId: 'thread:one', title: 'One', mode: 'orchestrator' }, clientX: 950, clientY: 300 },
    })));
    expect((overlay.firstElementChild as HTMLElement).style.top).toBe('25%');
    top = 140;
    await act(async () => window.dispatchEvent(new CustomEvent(THREAD_DRAG_MOVE_EVENT, { detail: { clientX: 950, clientY: 300 } })));
    expect((overlay.firstElementChild as HTMLElement).style.top).toBe('17.5%');
  });

  it.each(['cancel', 'inactive'])('coalesces scroll refresh and clears it on %s', async (stop) => {
    const source = Array.from({ length: 10 }, (_, index) => `worker:${index + 1}`)
      .reduce((layout, key) => addSessionToLayout(layout, key), createDefaultSessionTileLayout());
    const worker = collectSessionLeaves(source.root)[0]!;
    const onDrop = vi.fn();
    const render = (active: boolean) => root.render(createElement('div', null,
      createElement('div', { 'data-session-tile-surface': 'true' },
        createElement('div', { 'data-session-tile-leaf-id': worker.id })),
      createElement(ThreadDropLayer, { active, layout: projectResponsiveAutomaticSessionTiles(source, 'balanced'), onDrop, useRenderedLeafRects: true }),
    ));
    await act(async () => render(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const overlay = host.querySelector<HTMLElement>('[data-thread-drop-layer]')!;
    const pane = host.querySelector<HTMLElement>('[data-session-tile-leaf-id]')!;
    overlay.getBoundingClientRect = () => box(0, 0, 1000, 800);
    pane.getBoundingClientRect = () => box(700, 200, 280, 240);
    await act(async () => window.dispatchEvent(new CustomEvent(THREAD_DRAG_START_EVENT, {
      detail: { payload: { threadId: 'thread:one', title: 'One', mode: 'orchestrator' }, clientX: 950, clientY: 300 },
    })));
    let scheduled: FrameRequestCallback | undefined;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { scheduled = callback; return 17; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      await act(async () => { pane.dispatchEvent(new Event('scroll')); pane.dispatchEvent(new Event('scroll')); });
      expect(request).toHaveBeenCalledOnce();
      await act(async () => {
        if (stop === 'cancel') window.dispatchEvent(new CustomEvent(THREAD_DRAG_CANCEL_EVENT));
        else render(false);
      });
      expect(cancel).toHaveBeenCalledWith(17);
      // Even a callback already in flight must not restore a stopped preview.
      await act(async () => { scheduled?.(0); });
      expect(overlay.childElementCount).toBe(0);
      await act(async () => window.dispatchEvent(new CustomEvent(THREAD_DRAG_END_EVENT, { detail: { clientX: 950, clientY: 300 } })));
      expect(onDrop).not.toHaveBeenCalled();
    } finally { request.mockRestore(); cancel.mockRestore(); }
  });
});
