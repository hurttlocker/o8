// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { splitLeafWithThread, createDefaultSessionTileLayout, collectThreadLeaves } from '@/lib/orchestrator/session-tiles';
import type { ThoughtsChatPanelChromeState } from '../thoughts/chat-panel/types';
import { SessionTileSurface } from './SessionTileSurface';
import { ThreadDropLayer } from './ThreadDropLayer';
import { useSessionTiles } from './use-session-tiles';

vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] } }) }));
vi.mock('../thoughts/ThoughtsChatPanel', () => ({ ThoughtsChatPanel: forwardRef(function MockChat({ onChromeChange }: {
  onChromeChange: (state: ThoughtsChatPanelChromeState) => void;
}, ref) {
  const [threadId, setThreadId] = useState('');
  useImperativeHandle(ref, () => ({ loadThread: async (id: string) => {
    setThreadId(id); onChromeChange({ threadId: id } as ThoughtsChatPanelChromeState);
  } }));
  return createElement('textarea', { 'aria-label': `Draft ${threadId}`, defaultValue: '' });
}) }));
let host: HTMLDivElement; let root: Root;
const storageKey = 'o8:orchestrator:session-tiles:tab:pane-move';
const live: string[] = [];
function Harness() {
  const tiles = useSessionTiles({ tabId: 'pane-move', repoPath: '/repos/site', liveSessionKeys: live });
  return createElement('div', null, createElement(SessionTileSurface, { layout: tiles.layout, focusedSessionKey: null,
    chatSlot: createElement('p', null, 'Main chat'), onResizeSplit: tiles.resizeSplit,
    onCloseLeaf: tiles.closeSessionLeafById, onFocusSession: tiles.setFocusedSessionKey }),
    createElement(ThreadDropLayer, { active: true, layout: tiles.layout, onDrop: action => {
      if (action.kind === 'split') tiles.splitLeafWithThreadPane(action.leafId, action.thread, action.direction);
      if (action.kind === 'replace' || action.kind === 'replace-chat') tiles.replaceLeafWithThreadPane(action.leafId, action.thread);
    } }));
}
function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } }); target.dispatchEvent(event);
}
const draft = (id: string) => host.querySelector<HTMLTextAreaElement>(`[aria-label="Draft ${id}"]`)!;
const header = (id: string) => draft(id).closest('[data-session-tile-leaf-id]')!.querySelector('button')!.parentElement!;
async function render() {
  await act(async () => { root.render(createElement(Harness)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  host.querySelector<HTMLElement>('[data-thread-drop-layer]')!.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800,
  } as DOMRect);
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  let layout = splitLeafWithThread(createDefaultSessionTileLayout(), 'chat-root', { threadId: 'one', title: 'One', mode: 'chat' }, 'vertical');
  layout = splitLeafWithThread(layout, collectThreadLeaves(layout.root)[0].id, { threadId: 'two', title: 'Two', mode: 'chat' }, 'horizontal');
  localStorage.setItem(storageKey, JSON.stringify(layout));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('moves a split from its own header, keeping its leaf, mounted composer, draft and persisted placement', async () => {
  const before = draft('two'); before.value = 'Unsent work stays here';
  const leafId = before.closest<HTMLElement>('[data-session-tile-leaf-id]')!.dataset.sessionTileLeafId;
  await act(async () => { pointer(header('two'), 'pointerdown', 700, 410); pointer(document, 'pointermove', 100, 650); pointer(document, 'pointerup', 100, 650); });
  const saved = JSON.parse(localStorage.getItem(storageKey)!);
  expect(saved.root.children[0].type).toBe('split'); expect(saved.root.children[0].direction).toBe('horizontal');
  expect(saved.root.children[0].children[1].id).toBe(leafId);
  expect(draft('two')).toBe(before); expect(draft('two').value).toBe('Unsent work stays here');
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(draft('two').closest<HTMLElement>('[data-session-tile-leaf-id]')!.dataset.sessionTileLeafId).toBe(leafId);
});
it('swaps two existing panes at their headers without replacing either composer or draft', async () => {
  const one = draft('one'); const two = draft('two'); one.value = 'First draft'; two.value = 'Second draft';
  await act(async () => { pointer(header('two'), 'pointerdown', 700, 410); pointer(document, 'pointermove', 700, 10); pointer(document, 'pointerup', 700, 10); });
  const saved = JSON.parse(localStorage.getItem(storageKey)!);
  expect(collectThreadLeaves(saved.root).map(leaf => leaf.threadId)).toEqual(['two', 'one']);
  expect(draft('one')).toBe(one); expect(draft('two')).toBe(two);
  expect(one.value).toBe('First draft'); expect(two.value).toBe('Second draft');
});

it('swaps a thread with the main pane without remounting either view', async () => {
  const main = host.querySelector('p'); const two = draft('two'); two.value = 'Keep my draft';
  await act(async () => { pointer(header('two'), 'pointerdown', 700, 410); pointer(document, 'pointermove', 100, 10); pointer(document, 'pointerup', 100, 10); });
  const saved = JSON.parse(localStorage.getItem(storageKey)!);
  expect(saved.root.children[0].threadId).toBe('two');
  expect(host.querySelector('p')).toBe(main); expect(draft('two')).toBe(two); expect(two.value).toBe('Keep my draft');
});
