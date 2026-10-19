// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { WorkspaceHeaderStrip } from './WorkspaceHeaderStrip';
const dragWindow = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ startDragging: dragWindow }) }));
it('drags the native window from empty tab-strip space while preserving tab and control gestures', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, { workspaceId: 'workspace', headerActiveTabId: 'one',
      headerTabs: [{ id: 'one', label: 'One', kind: 'orchestrator', runtime: null, packetStatus: null }] })));
    const press = async (node: Element, button = 0) => act(async () => { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button })); });
    await press(host.querySelector('[role="tablist"]')!);
    expect(dragWindow).toHaveBeenCalledOnce(); dragWindow.mockClear();
    await press(host.querySelector('[role="tab"]')!);
    await press(host.querySelector('button')!);
    await press(host.querySelector('[role="tablist"]')!, 2);
    expect(dragWindow).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
