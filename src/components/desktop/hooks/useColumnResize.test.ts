// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResizeEdge } from '../shell/ResizeEdge';
import { useColumnResize } from './useColumnResize';

let host: HTMLDivElement; let root: Root; const commit = vi.fn();
function pointer(target: EventTarget, type: string, x: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}
function Harness() {
  const [, dragging] = useState(false);
  const start = useColumnResize(dragging);
  return createElement('div', null, createElement('div', null,
    createElement(ResizeEdge, { 'aria-label': 'Right panel width', onPointerDown: event => start(event, {
      side: 'right', min: 280, max: 1600, commit,
    }) }), createElement('div', { 'data-mcp-scope': 'chat-panel', style: { width: 440 } })));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); commit.mockClear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.documentElement.style.removeProperty('zoom'); vi.unstubAllGlobals(); });
function measure(zoom = 1, width = 350, available = 900) {
  document.documentElement.style.setProperty('zoom', String(zoom));
  const column = host.querySelector<HTMLElement>('[data-mcp-scope]')!;
  column.getBoundingClientRect = () => ({ width: width * zoom } as DOMRect);
  column.parentElement!.parentElement!.getBoundingClientRect = () => ({ width: available * zoom } as DOMRect);
  return { column, edge: host.querySelector<HTMLElement>('[role="separator"]')! };
}
it.each([0.8, 1, 1.25])('starts at the rendered width and commits the release position at %s zoom', async zoom => {
  const { edge, column } = measure(zoom);
  await act(async () => { pointer(edge, 'pointerdown', 500); pointer(document, 'pointermove', 490, 2); });
  expect(column.style.width).toBe('440px'); expect(commit).not.toHaveBeenCalled();
  await act(async () => { pointer(document, 'pointermove', 500 - 10 * zoom); pointer(document, 'pointerup', 500 - 25 * zoom); });
  expect(commit).toHaveBeenCalledExactlyOnceWith(375); expect(column.style.width).toBe('375px');
});
it('bounds the side panel so the center keeps its usable width', async () => {
  const { edge, column } = measure(1, 350, 900);
  await act(async () => { pointer(edge, 'pointerdown', 500); pointer(document, 'pointermove', 0); pointer(document, 'pointerup', 0); });
  expect(column.style.width).toBe('472px'); expect(commit).toHaveBeenCalledExactlyOnceWith(472);
});
it.each(['Escape', 'pointercancel', 'blur', 'unmount'])('restores the rendered width and cursor after %s', async reason => {
  document.body.style.cursor = 'crosshair'; document.body.style.userSelect = 'text';
  const { edge, column } = measure();
  await act(async () => { pointer(edge, 'pointerdown', 500); pointer(document, 'pointermove', 480); });
  expect(document.body.style.cursor).toBe('col-resize');
  await act(async () => {
    if (reason === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (reason === 'blur') window.dispatchEvent(new Event('blur'));
    else if (reason === 'unmount') root.render(null);
    else pointer(document, 'pointercancel', 480);
  });
  expect(column.style.width).toBe('440px'); expect(commit).not.toHaveBeenCalled();
  expect(document.body.style.cursor).toBe('crosshair'); expect(document.body.style.userSelect).toBe('text');
  document.body.style.cursor = ''; document.body.style.userSelect = '';
});
