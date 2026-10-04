// jsdom is a transitive test dependency without bundled declarations.
// @ts-expect-error test-only module has no bundled types
import { JSDOM } from 'jsdom';
import { act, createElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceTerminalRoot } from '@/components/desktop/workspace-terminal/WorkspaceTerminalRoot';
import type { TerminalTab, TerminalTabHandle, WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';
import type { PersistedTabState } from '@/lib/terminal/tab-state';
import { FRESH_ORCHESTRATOR_EVENT, FRESH_RECEIPT_ATTRIBUTE } from '@/lib/desktop/fresh-orchestrator-action';
import { createO8WebviewToolHandlers } from './o8-webview-tools';
import type { O8WebviewClient } from './o8-webview-client';

// Actual workspace root, action registration, restore/controller and forceFresh
// callback. Only HTTP storage/liveness, heavy panels, feature hooks and geometry
// are fixtures. No inventory, action bridge or spawn/reuse logic is mocked.
vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));
const panel = vi.hoisted(() => ({ disabled: false }));
vi.mock('@/components/desktop/workspace-terminal/WorkspaceTerminalPanels', async () => {
  const { createElement: h } = await import('react');
  return { WorkspaceTerminalPanels: ({ visibleTabs, effectiveActiveTabId }: { visibleTabs: TerminalTab[]; effectiveActiveTabId: string }) => h('div', null,
    ...visibleTabs.map(tab => h('article', { key: tab.id, 'data-tab-id': tab.id, 'data-thread': tab.orchestratorThreadId }, tab.label)),
    h('textarea', { 'data-o8-active-composer': 'true', disabled: panel.disabled, 'data-composer-tab': effectiveActiveTabId })) };
});
vi.mock('@/components/desktop/workspace-terminal/PreviewPane', () => ({ PreviewPane: () => null }));
vi.mock('@/components/desktop/workspace-terminal/use-outside-worker-split-mount', () => ({ useOutsideWorkerSplitMount: () => undefined }));

const repo = { name: 'fixture', localPath: '/repos/fixture' };
let dom: JSDOM;
let reactRoot: Root;
let host: HTMLDivElement;
let handle: RefObject<TerminalTabHandle | null>;
let saved: PersistedTabState;
let dispatches: number;
let readsAfterDispatch: number;
let dropAck: boolean;
let dropObservation: boolean;
let beforeMutation: (() => void) | null;
let scope = 0;
function surface() { return host.querySelector<HTMLElement>('[data-o8-workspace-root]')!; }
function snapshot() { return handle.current!.getTabsSnapshot(); }
function inventory() { return snapshot().tabs.map(tab => tab.id); }
function client() {
  return {
    evalJs: async (code: string) => {
      const mutation = code.includes('const phase = "dispatch"');
      if (mutation) beforeMutation?.();
      if (dispatches && !mutation) {
        readsAfterDispatch += 1;
        if (dropObservation) throw new Error('observation disconnected');
      }
      let result = '';
      await act(async () => { result = dom.window.eval(code) as string; });
      if (mutation && dropAck) throw new Error('acknowledgement disconnected');
      return { result };
    },
  } as unknown as O8WebviewClient;
}
async function run(args: Record<string, unknown> = {}) {
  const result = await createO8WebviewToolHandlers(client).o8_view_new_orchestrator_session(args);
  const content = result.content[0];
  if (content.type !== 'text') throw new Error('expected structured text receipt');
  return JSON.parse(content.text);
}
async function mount(activeTabId: string, withBlank = true) {
  scope += 1;
  saved = {
    version: 1, activeTabId, savedAt: new Date(0).toISOString(),
    tabs: [
      { id: 'used-tab', label: 'Prior conversation', kind: 'orchestrator', cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath, orchestratorThreadId: 'thoughts-used' },
      ...(withBlank ? [{ id: 'blank-tab', label: 'Orchestrator', kind: 'orchestrator' as const, cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath, freshSpawn: true }] : []),
      { id: 'terminal-tab', label: 'Prior terminal', kind: 'terminal', cliAgent: 'shell', repoName: repo.name, repoPath: repo.localPath },
    ],
  };
  const expectedIds = saved.tabs.map(tab => tab.id);
  const props: WorkspaceTerminalProps = {
    stateScope: `freshness-fixture-${scope}`, preferredRepo: repo, selectedRepo: repo,
    activeWorkspaceSurface: true, splitCreated: true, defaultTab: 'llm-chat', autoCreateDefaultTab: false, termWsConnected: false,
    sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalDetach: vi.fn(),
    sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(),
  };
  await act(async () => reactRoot.render(createElement(WorkspaceTerminalRoot, { ...props, ref: handle })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(inventory()).toEqual(expectedIds);
  expect(surface().getAttribute('data-o8-active-tab-id')).toBe(activeTabId);
  surface().addEventListener(FRESH_ORCHESTRATOR_EVENT, () => { dispatches += 1; });
}
beforeEach(() => {
  dom = new JSDOM('', { url: 'http://localhost/dashboard', runScripts: 'outside-only' });
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'CustomEvent', 'MutationObserver', 'localStorage'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/panel/terminal-state')) {
      if (init?.method === 'POST' && String(input).endsWith(`scope=freshness-fixture-${scope}`)) saved = JSON.parse(String(init.body)) as PersistedTabState;
      return new Response(JSON.stringify(saved), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 } as DOMRect);
  host = document.createElement('div'); document.body.append(host); reactRoot = createRoot(host); handle = { current: null };
  panel.disabled = false; dispatches = 0; readsAfterDispatch = 0; dropAck = false; dropObservation = false; beforeMutation = null;
});
afterEach(async () => { await act(async () => reactRoot.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

describe('registered genuine fresh-session action through the real root/controller', () => {
  for (const [activeTabId, withBlank] of [['used-tab', true], ['blank-tab', true], ['used-tab', false]] as const) {
    it(`creates exactly one fresh tab from ${activeTabId}, blank=${withBlank}`, async () => {
      await mount(activeTabId, withBlank);
      const before = snapshot().tabs;
      const result = await run({ repo: 'fixture' });
      expect(result).toMatchObject({ ok: true, state: { activeWorkspaceRepo: 'fixture', composerFocused: true } });
      expect(before.map(tab => tab.id)).not.toContain(result.tabId);
      expect(inventory()).toEqual([...before.map(tab => tab.id), result.tabId]);
      expect(snapshot().tabs.slice(0, before.length)).toEqual(before);
      expect(surface().getAttribute('data-o8-active-tab-id')).toBe(result.tabId);
      expect(document.activeElement?.getAttribute('data-composer-tab')).toBe(result.tabId);
      expect(host.querySelector('[data-tab-id="used-tab"]')?.getAttribute('data-thread')).toBe('thoughts-used');
      expect(host.querySelector('[data-tab-id="terminal-tab"]')).not.toBeNull();
      expect(dispatches).toBe(1);
    });
  }
  it('preserves ordinary imperative callback pristine reuse', async () => {
    await mount('used-tab'); const before = inventory();
    await act(async () => { handle.current!.openOrchestratorTab(repo); });
    expect(surface().getAttribute('data-o8-active-tab-id')).toBe('blank-tab');
    expect(inventory()).toEqual(before); expect(dispatches).toBe(0);
  });
  it('refuses ambiguous and disabled surfaces before dispatch', async () => {
    await mount('used-tab');
    const clone = surface().cloneNode(true); host.append(clone);
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    clone.parentNode?.removeChild(clone);
    surface().setAttribute('aria-disabled', 'true');
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    expect(dispatches).toBe(0);
  });
  it('refuses a mismatched requested repo or missing action', async () => {
    await mount('used-tab');
    expect(await run({ repo: 'other' })).toMatchObject({ ok: false, actionDispatched: false });
    surface().removeAttribute('data-o8-fresh-session-action');
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    expect(dispatches).toBe(0);
  });
  it('rechecks workspace/project before invoking the callback', async () => {
    await mount('used-tab'); const before = inventory();
    beforeMutation = () => surface().setAttribute('data-o8-active-repo-path', '/repos/other');
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    expect(inventory()).toEqual(before); expect(dispatches).toBe(0);
  });
  it('refuses changed workspace, disconnected root and expired action before creation', async () => {
    await mount('used-tab'); const before = inventory();
    const workspaceId = surface().getAttribute('data-o8-workspace-id')!;
    beforeMutation = () => surface().setAttribute('data-o8-workspace-id', 'changed-workspace');
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    surface().setAttribute('data-o8-workspace-id', workspaceId);
    const root = surface();
    beforeMutation = () => root.remove();
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    host.append(root);
    await act(async () => reactRoot.unmount());
    reactRoot = createRoot(host);
    await mount('used-tab');
    const late = Date.now() + 6_000;
    beforeMutation = () => { vi.spyOn(Date, 'now').mockReturnValue(late); vi.spyOn(dom.window.Date, 'now').mockReturnValue(late); };
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    expect(inventory()).toEqual(before); expect(dispatches).toBe(0);
  });
  it('rejects invalid schema without accessing the native client', async () => {
    const getClient = vi.fn(client);
    const handlers = createO8WebviewToolHandlers(getClient);
    for (const args of [{ arbitraryCode: 'ignored' }, { repo: 7 }]) {
      expect(await handlers.o8_view_new_orchestrator_session(args)).toMatchObject({ isError: true });
    }
    expect(getClient).not.toHaveBeenCalled();
  });
  it('rejects a controller inventory change before its React render commits', async () => {
    await mount('used-tab', false); const before = inventory();
    beforeMutation = () => { handle.current!.openOrchestratorTab(repo); };
    expect(await run()).toMatchObject({ ok: false, actionDispatched: false });
    expect(inventory()).toHaveLength(before.length + 1); // ordinary callback only
  });
  it('reconciles a lost dispatch acknowledgement with readonly observations', async () => {
    await mount('blank-tab'); const before = inventory(); dropAck = true;
    const result = await run();
    expect(result).toMatchObject({ ok: true });
    expect(inventory()).toEqual([...before, result.tabId]);
    expect(dispatches).toBe(1); expect(readsAfterDispatch).toBeGreaterThan(0);
  });
  it('returns unknown on disconnected observation without replay', async () => {
    await mount('used-tab'); const before = inventory(); dropAck = true; dropObservation = true;
    expect(await run()).toMatchObject({ ok: false, mutationOutcome: 'unknown', automaticReplay: false });
    expect(inventory()).toHaveLength(before.length + 1); expect(dispatches).toBe(1);
  });
  it('keeps a created tab pending while its composer is disabled without replay', async () => {
    await mount('used-tab'); const before = inventory();
    panel.disabled = true;
    expect(await run()).toMatchObject({ ok: false, status: 'pending', code: 'enabled_composer_not_observed', automaticReplay: false });
    expect(inventory()).toHaveLength(before.length + 1); expect(dispatches).toBe(1);
  }, 12_000);
  it('deduplicates the same bounded action request at the real bridge', async () => {
    await mount('used-tab'); expect(await run()).toMatchObject({ ok: true });
    const receipt = JSON.parse(surface().getAttribute(FRESH_RECEIPT_ATTRIBUTE)!);
    const before = inventory();
    await act(async () => surface().dispatchEvent(new dom.window.CustomEvent(FRESH_ORCHESTRATOR_EVENT, { detail: {
      requestId: receipt.requestId, expiresAt: Date.now() + 5_000, capability: surface().getAttribute('data-o8-fresh-session-action'),
      workspaceId: receipt.workspaceId, repoPath: receipt.repoPath, activeTabId: before.at(-1), tabIds: before,
    } })));
    expect(inventory()).toEqual(before);
  });
});
