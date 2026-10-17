// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HeaderPillStrip } from './WorkspaceHeaderStrip';
import { ThreadDropLayer } from '../workspace-terminal/ThreadDropLayer';
import { useSessionTiles } from '../workspace-terminal/use-session-tiles';
import { collectThreadLeaves } from '@/lib/orchestrator/session-tiles';
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
const tabs = ['one', 'two', 'three'].map(id => ({ id, label: id, kind: 'orchestrator', runtime: null,
  packetStatus: null, orchestratorThreadId: `thread-${id}`, repoPath: '/repos/site' }));
let host: HTMLDivElement; let root: Root; const reorder = vi.fn();
function Harness() {
  const tiles = useSessionTiles({ tabId: 'drag-fixture', repoPath: '/repos/site', liveSessionKeys: [] });
  return createElement('div', null, createElement(HeaderPillStrip, { tabs, activeTabId: 'one', workspaceId: 'pane-one' }),
    createElement(ThreadDropLayer, { active: true, layout: tiles.layout, onDrop: action => {
      if (action.kind === 'split') tiles.splitLeafWithThreadPane(action.leafId, action.thread, action.direction);
      else tiles.replaceLeafWithThreadPane(action.leafId, action.thread);
    } }), createElement('output', null, JSON.stringify(collectThreadLeaves(tiles.layout.root))));
}
function pointer(target: EventTarget, type: string, x: number, y: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } }); target.dispatchEvent(event);
}
const tab = (id: string) => host.querySelector<HTMLElement>(`[data-o8-workspace-tab="${id}"]`)!;
async function render() {
  await act(async () => root.render(createElement(Harness)));
  host.querySelector<HTMLElement>('[data-thread-drop-layer]')!.getBoundingClientRect = () => ({
    left: 0, top: 60, width: 1000, height: 740, right: 1000, bottom: 800,
  } as DOMRect);
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); reorder.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  window.addEventListener('o8:request-reorder-tabs', reorder); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.removeEventListener('o8:request-reorder-tabs', reorder); vi.unstubAllGlobals(); });
it('reorders through the rendered workspace header with explicit before/after and owner identity', async () => {
  const target = tab('three'); target.getBoundingClientRect = () => ({ left: 200, top: 0, width: 100, height: 40 } as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  await act(async () => { pointer(tab('one'), 'pointerdown', 30, 20); pointer(document, 'pointermove', 275, 20); });
  expect(host.querySelector('[data-tab-insertion="after"]')).not.toBeNull();
  await act(async () => pointer(document, 'pointerup', 275, 20));
  expect(reorder).toHaveBeenCalledOnce(); expect((reorder.mock.calls[0][0] as CustomEvent).detail).toEqual({
    workspaceId: 'pane-one', tabId: 'one', targetId: 'three', after: true,
  });
  expect(host.querySelector('output')!.textContent).toBe('[]');
});
it.each([[800, 300, 'vertical'], [200, 650, 'horizontal']])('opens the exact saved chat at %s,%s and restores its split', async (x, y, direction) => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host.querySelector('[data-thread-drop-layer]') });
  await act(async () => { pointer(tab('two'), 'pointerdown', 100, 20); pointer(document, 'pointermove', Number(x), Number(y)); pointer(document, 'pointerup', Number(x), Number(y)); });
  const key = 'o8:orchestrator:session-tiles:tab:drag-fixture';
  expect(localStorage.getItem(key)).toContain(`"direction":"${direction}"`);
  expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual([expect.objectContaining({ threadId: 'thread-two', title: 'two', repoPath: '/repos/site' })]);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(host.querySelector('output')!.textContent).toContain('thread-two'); expect(reorder).not.toHaveBeenCalled();
});
it('Escape cancels the tab drag and both drop destinations', async () => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => tab('three') });
  await act(async () => { pointer(tab('one'), 'pointerdown', 30, 20); pointer(document, 'pointermove', 800, 300); });
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await act(async () => pointer(document, 'pointerup', 800, 300));
  expect(reorder).not.toHaveBeenCalled(); expect(host.querySelector('output')!.textContent).toBe('[]');
  expect(host.querySelector('[data-tab-insertion]')).toBeNull();
});
