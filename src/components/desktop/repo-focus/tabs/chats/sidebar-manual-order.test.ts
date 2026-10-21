// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatsTab } from '../ChatsTab';
import { CHAT_GROUP_BY_KEY } from './sidebar-view';
import { SIDEBAR_MANUAL_ORDER_KEY } from './use-sidebar-manual-order';
import { THREAD_DRAG_START_EVENT } from '@/lib/workspace-terminal/thread-drag';
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
const repo = { id: 'site', name: 'site', localPath: '/repos/site', remoteUrl: null, defaultBranch: 'main' };
let host: HTMLDivElement; let root: Root; const open = vi.fn();
const render = () => act(async () => root.render(createElement(ChatsTab, { repos: [repo], variant: 'mini',
  groupMode: 'flat', showLiveSessions: false, onOpenHistoryChat: open })));
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-sidebar-chat-id]')];
const ids = () => rows().map(row => row.dataset.sidebarChatId);
function pointer(target: EventTarget, type: string, y: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true } }); target.dispatchEvent(event);
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); open.mockClear();
  vi.stubGlobal('fetch', vi.fn(async input => String(input).includes('chat-history/list') ? Response.json({ conversations:
    ['pin', 'one', 'two', 'three'].map((tabId, index) => ({ tabId, title: tabId, preview: 'Preview', empty: false,
      messageCount: 2, model: 'codex', savedAt: new Date(Date.now() - index * 60_000).toISOString(),
      modifiedAt: new Date(Date.now() - index * 60_000).toISOString(), pinned: index === 0, starred: false, repoPath: repo.localPath })) })
    : Response.json({ lanes: [], agents: [], approvals: [], fixtures: [] })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function target(id: string) {
  const row = rows().find(row => row.dataset.sidebarChatId === id)!;
  row.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 0, right: 200, width: 200, height: 40 } as DOMRect);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => row }); return row;
}
it('drags a real history row without opening it, saves manual order, and restores it after remount', async () => {
  await render(); expect(ids()).toEqual(['pin', 'one', 'two', 'three']);
  const first = rows()[1]; target('three');
  await act(async () => { pointer(first.firstElementChild!, 'pointerdown', 80); pointer(document, 'pointermove', 135); });
  expect(host.querySelector('[data-sidebar-insertion="after"]')).not.toBeNull();
  await act(async () => { pointer(document, 'pointerup', 135); first.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  expect(open).not.toHaveBeenCalled(); expect(ids()).toEqual(['pin', 'two', 'three', 'one']);
  expect(localStorage.getItem(CHAT_GROUP_BY_KEY)).toBe('manual');
  expect(JSON.parse(localStorage.getItem(SIDEBAR_MANUAL_ORDER_KEY)!)).toEqual(['pin', 'two', 'three', 'one']);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(ids()).toEqual(['pin', 'two', 'three', 'one']);
});
it.each(['Escape', 'pointercancel', 'blur'])('cancels %s without saving, opening, or keeping a drag marker', async reason => {
  await render(); const source = rows()[1]; target('three');
  await act(async () => { pointer(source, 'pointerdown', 80); pointer(document, 'pointermove', 135); });
  await act(async () => {
    if (reason === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (reason === 'blur') window.dispatchEvent(new Event('blur')); else pointer(document, 'pointercancel', 135);
    pointer(document, 'pointerup', 135);
  });
  expect(ids()).toEqual(['pin', 'one', 'two', 'three']); expect(localStorage.getItem(SIDEBAR_MANUAL_ORDER_KEY)).toBeNull();
  expect(host.querySelector('[data-sidebar-insertion]')).toBeNull(); expect(open).not.toHaveBeenCalled();
});
it('keeps pins separate and supports keyboard reordering without changing chat identity', async () => {
  await render(); const source = rows()[1]; target('pin');
  await act(async () => { pointer(source, 'pointerdown', 80); pointer(document, 'pointermove', 135); pointer(document, 'pointerup', 135); });
  expect(localStorage.getItem(SIDEBAR_MANUAL_ORDER_KEY)).toBeNull();
  await act(async () => source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true, bubbles: true })));
  expect(ids()).toEqual(['pin', 'two', 'one', 'three']); expect(open).not.toHaveBeenCalled();
});
it('leaves an ordinary click as an exact chat open and ignores clicks on nested controls for dragging', async () => {
  await render(); const start = vi.fn(); window.addEventListener(THREAD_DRAG_START_EVENT, start);
  try {
    const row = rows()[1].firstElementChild!;
    await act(async () => { pointer(row, 'pointerdown', 100); pointer(document, 'pointerup', 100); row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(open).toHaveBeenCalledExactlyOnceWith('one', 'one', expect.objectContaining({ localPath: repo.localPath })); expect(start).not.toHaveBeenCalled();
  } finally { window.removeEventListener(THREAD_DRAG_START_EVENT, start); }
});
