// @vitest-environment jsdom

import { act, createElement, forwardRef, type ForwardedRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTabHandle, WorkspaceTerminalProps } from './types';
import { subscribeTerminalCloseConfirm, type TerminalCloseRequest } from './terminal-close-confirm';

const restoreHarness = vi.hoisted(() => ({
  resolveValidated: null as null | ((value: unknown) => void),
  validatedPromise: null as Promise<unknown> | null,
  savedSession: null as string | null,
  useActualRestore: false,
}));

vi.mock('./terminal-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./terminal-restore')>();
  const restoredTabs = () => ([
    {
      id: 'terminal-a', label: 'Terminal A', kind: 'terminal', tmuxSession: restoreHarness.savedSession,
      cliAgent: 'shell', createdAt: 1, lastActivity: 1,
    },
    {
      id: 'terminal-b', label: 'Terminal B', kind: 'terminal', tmuxSession: null,
      cliAgent: 'shell', createdAt: 2, lastActivity: 2,
    },
  ]);
  const result = () => ({
    tabs: restoredTabs(),
    activeTabId: 'terminal-a',
    sessionsToAttach: [],
    deadTerminalTabs: restoredTabs().filter(tab => tab.tmuxSession === null),
    restoredAny: true,
  });
  return {
    ...actual,
    loadInitialTabState: vi.fn(async () => ({
      version: 1,
      activeTabId: 'terminal-a',
      savedAt: new Date(0).toISOString(),
      tabs: [],
    })),
    computeRestoredTabs: vi.fn(async (saved, options, cancelled, mode) => restoreHarness.useActualRestore
      ? actual.computeRestoredTabs(saved, options, cancelled, mode)
      : mode === 'optimistic' ? result() : restoreHarness.validatedPromise),
  };
});

const experimental = vi.hoisted(() => ({ chat: false }));
vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => experimental.chat }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));
vi.mock('./orchestrator-thread-restore', () => ({ readLastOrchestratorThreadTitle: vi.fn(async () => null) }));

import { useWorkspaceTerminalController } from './useWorkspaceTerminalController';
import { loadInitialTabState } from './terminal-restore';

function ControllerHarness({
  controllerRef,
  props,
}: {
  controllerRef: ForwardedRef<TerminalTabHandle>;
  props: WorkspaceTerminalProps;
}) {
  const controller = useWorkspaceTerminalController(props, controllerRef);
  return createElement('div', {
    'data-tabs': JSON.stringify(controller.tabs),
    'data-active-tab': controller.effectiveActiveTabId,
    'data-sessions': JSON.stringify(controller.tabs.map((tab) => [tab.id, tab.tmuxSession])),
  });
}

const ForwardedControllerHarness = forwardRef<TerminalTabHandle, { props: WorkspaceTerminalProps }>(
  function ForwardedControllerHarness({ props }, ref) {
    return createElement(ControllerHarness, { controllerRef: ref, props });
  },
);

describe('useWorkspaceTerminalController restore acknowledgements', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    experimental.chat = false;
    restoreHarness.savedSession = null;
    restoreHarness.useActualRestore = false;
    restoreHarness.validatedPromise = new Promise((resolve) => {
      restoreHarness.resolveValidated = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns from Automations to the exact terminal or file without changing tab identity or order', async () => {
    const controllerRef = { current: null as TerminalTabHandle | null };
    const props: WorkspaceTerminalProps = {
      stateScope: 'utility-return-fixture', defaultTab: 'terminal', autoCreateDefaultTab: false,
      termWsConnected: false, sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(),
      sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(), sendTerminalDetach: vi.fn(),
    };
    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props })));
    let fileId = '';
    await act(async () => { fileId = controllerRef.current!.openInspectorTab({ id: 'source-file', label: 'README.md', kind: 'file', resourceId: '/repo/README.md' }); });
    for (const entry of ['terminal-b', fileId]) {
      await act(async () => { controllerRef.current!.focusTab(entry); });
      const before = JSON.parse(container.firstElementChild!.getAttribute('data-tabs')!);
      for (let round = 0; round < 3; round++) {
        let utilityId = '';
        await act(async () => { utilityId = controllerRef.current!.openInspectorTab({ id: 'automations', kind: 'automations', label: 'Automations', resourceId: 'automations' }); });
        expect(container.firstElementChild!.getAttribute('data-active-tab')).toBe(utilityId);
        // Reopening the already active page must not overwrite its return target.
        await act(async () => { controllerRef.current!.openInspectorTab({ id: 'automations', kind: 'automations', label: 'Automations', resourceId: 'automations' }); });
        await act(async () => { controllerRef.current!.closeActiveTab(); });
        expect(container.firstElementChild!.getAttribute('data-active-tab')).toBe(entry);
        expect(JSON.parse(container.firstElementChild!.getAttribute('data-tabs')!)).toEqual(before);
      }
    }
    expect(props.sendTerminalCreate).not.toHaveBeenCalled();
    expect(props.sendTerminalDetach).not.toHaveBeenCalled();
  });

  it.each([false, true])('opens only a fresh orchestrator for a rail drop when experimental chat is %s', async (experimentalChat) => {
    experimental.chat = experimentalChat;
    vi.mocked(loadInitialTabState).mockResolvedValueOnce(null);
    const selectedRepo = { name: 'Selected repo', localPath: '/tmp/selected-repo', branch: 'main' };
    const props: WorkspaceTerminalProps = {
      stateScope: 'fixture-rail-orchestrator-pane', defaultTab: 'orchestrator', splitCreated: true, selectedRepo,
      termWsConnected: false, sendTerminalCreate: vi.fn(), sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(),
      sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(), sendTerminalDetach: vi.fn(),
    };
    await act(async () => root.render(createElement(ForwardedControllerHarness, { props })));
    const tabs = JSON.parse(container.firstElementChild!.getAttribute('data-tabs')!);
    expect(tabs).toEqual([expect.objectContaining({ kind: 'orchestrator', freshSpawn: true, mode: 'fleet', label: 'Orchestrator', repo: selectedRepo })]);
    expect(props.sendTerminalCreate).not.toHaveBeenCalled();
  });

  it('keeps an ack that lands during validation without detaching or requesting the tab twice', async () => {
    const sendTerminalCreate = vi.fn<WorkspaceTerminalProps['sendTerminalCreate']>();
    const sendTerminalDetach = vi.fn<WorkspaceTerminalProps['sendTerminalDetach']>();
    const controllerRef = { current: null as TerminalTabHandle | null };
    const props: WorkspaceTerminalProps = {
      stateScope: 'tile-root',
      defaultTab: 'terminal',
      autoCreateDefaultTab: false,
      sendTerminalCreate,
      sendTerminalAttach: vi.fn(),
      sendTerminalInput: vi.fn(),
      sendTerminalResize: vi.fn(),
      sendTerminalVisibility: vi.fn(),
      sendTerminalDetach,
      termWsConnected: true,
    };

    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props })));
    await act(async () => Promise.resolve());
    expect(sendTerminalCreate).toHaveBeenCalledTimes(2);
    const requestId = sendTerminalCreate.mock.calls[0][2];
    expect(requestId).toEqual(expect.stringContaining('workspace-terminal-a-'));

    let duplicateResult = false;
    await act(async () => {
      expect(controllerRef.current?.onSessionCreated('cortex-dash-a', requestId)).toBe(true);
      duplicateResult = controllerRef.current?.onSessionCreated('cortex-dash-a', requestId) ?? false;
    });
    await act(async () => {
      restoreHarness.resolveValidated?.({
        tabs: [
          { id: 'terminal-a', label: 'Terminal A', kind: 'terminal', tmuxSession: null, cliAgent: 'shell', createdAt: 1, lastActivity: 1 },
          { id: 'terminal-b', label: 'Terminal B', kind: 'terminal', tmuxSession: null, cliAgent: 'shell', createdAt: 2, lastActivity: 2 },
        ],
        activeTabId: 'terminal-a',
        sessionsToAttach: [],
        deadTerminalTabs: [
          { id: 'terminal-a', label: 'Terminal A', kind: 'terminal', tmuxSession: null, cliAgent: 'shell', createdAt: 1, lastActivity: 1 },
          { id: 'terminal-b', label: 'Terminal B', kind: 'terminal', tmuxSession: null, cliAgent: 'shell', createdAt: 2, lastActivity: 2 },
        ],
        restoredAny: true,
      });
      await restoreHarness.validatedPromise;
    });

    expect(JSON.parse(container.firstElementChild?.getAttribute('data-sessions') ?? '[]')).toEqual([
      ['terminal-a', 'cortex-dash-a'],
      ['terminal-b', null],
    ]);
    expect(duplicateResult).toBe(true);
    expect(sendTerminalDetach).not.toHaveBeenCalled();
    expect(sendTerminalCreate).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('keeps a stopped saved process inert through restore and socket connection: %s', async (connected) => {
    restoreHarness.useActualRestore = true;
    vi.mocked(loadInitialTabState).mockResolvedValueOnce({
      version: 1, activeTabId: 'stopped-view', savedAt: new Date().toISOString(),
      tabs: [{ id: 'stopped-view', kind: 'terminal', label: 'Console / console', cliAgent: 'shell', tmuxSession: 'cortex-dash-stopped', repoPath: '/selected' }],
    });
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ sessions: [] })));
    const controllerRef = { current: null as TerminalTabHandle | null };
    const props: WorkspaceTerminalProps = {
      stateScope: 'stopped-saved-terminal', defaultTab: 'terminal', autoCreateDefaultTab: false,
      termWsConnected: connected, sendTerminalCreate: vi.fn(), sendTerminalDetach: vi.fn(),
      sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(),
    };
    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props })));
    const tabs = () => JSON.parse(container.firstElementChild!.getAttribute('data-tabs')!);
    for (let attempt = 0; attempt < 50 && !tabs()[0]?.terminalExit; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(tabs()).toEqual([expect.objectContaining({ id: 'stopped-view', tmuxSession: 'cortex-dash-stopped', terminalExit: { exitCode: null, transcript: '' } })]);
    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props: { ...props, termWsConnected: true } })));
    expect(props.sendTerminalCreate).not.toHaveBeenCalled();
    await act(async () => { controllerRef.current!.openTerminalTab({ name: 'Selected', localPath: '/selected' }); });
    expect(props.sendTerminalCreate).toHaveBeenCalledOnce();
    expect(tabs().find((entry: { id: string }) => entry.id === 'stopped-view').tmuxSession).toBe('cortex-dash-stopped');
    expect(tabs()).toHaveLength(2);
  });

  it('creates a shell only when validation explicitly returns a fresh unbound tab', async () => {
    restoreHarness.savedSession = 'cortex-dash-expired';
    const sendTerminalCreate = vi.fn<WorkspaceTerminalProps['sendTerminalCreate']>();
    const sendTerminalDetach = vi.fn<WorkspaceTerminalProps['sendTerminalDetach']>();
    const props: WorkspaceTerminalProps = {
      stateScope: 'dead-saved-terminal', defaultTab: 'terminal', autoCreateDefaultTab: false,
      termWsConnected: true, sendTerminalCreate, sendTerminalDetach,
      sendTerminalAttach: vi.fn(), sendTerminalInput: vi.fn(), sendTerminalResize: vi.fn(), sendTerminalVisibility: vi.fn(),
    };
    await act(async () => root.render(createElement(ForwardedControllerHarness, { props })));
    const terminalARequests = () => sendTerminalCreate.mock.calls.filter(call => String(call[2]).includes('terminal-a'));
    // The optimistic phase can attach the saved ID; it must not create over a live shell.
    expect(terminalARequests()).toHaveLength(0);
    await act(async () => {
      const dead = { id: 'terminal-a', label: 'Terminal A', kind: 'terminal', tmuxSession: null, cliAgent: 'shell', createdAt: 1, lastActivity: 1 };
      restoreHarness.resolveValidated?.({ tabs: [dead], activeTabId: 'terminal-a', sessionsToAttach: [], deadTerminalTabs: [dead], restoredAny: true });
      await restoreHarness.validatedPromise;
    });
    expect(JSON.parse(container.firstElementChild!.getAttribute('data-sessions')!)).toEqual([['terminal-a', null]]);
    expect(terminalARequests()).toHaveLength(1);
    expect(terminalARequests()[0][4]).toBe('workspace:terminal-a');
    expect(sendTerminalDetach).not.toHaveBeenCalled();
  });

  it('keeps live repo-less shells when the selected repo hydrates after restore', async () => {
    const sendTerminalCreate = vi.fn<WorkspaceTerminalProps['sendTerminalCreate']>();
    const sendTerminalAttach = vi.fn<WorkspaceTerminalProps['sendTerminalAttach']>();
    const controllerRef = { current: null as TerminalTabHandle | null };
    const props: WorkspaceTerminalProps = {
      stateScope: 'tile-root',
      defaultTab: 'terminal',
      autoCreateDefaultTab: false,
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput: vi.fn(),
      sendTerminalResize: vi.fn(),
      sendTerminalVisibility: vi.fn(),
      sendTerminalDetach: vi.fn(),
      termWsConnected: true,
    };

    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props })));
    await act(async () => Promise.resolve());
    expect(sendTerminalCreate).toHaveBeenCalledTimes(2);
    await act(async () => {
      expect(controllerRef.current?.onSessionCreated('cortex-dash-a', sendTerminalCreate.mock.calls[0][2])).toBe(true);
      expect(controllerRef.current?.onSessionCreated('cortex-dash-b', sendTerminalCreate.mock.calls[1][2])).toBe(true);
    });

    await act(async () => root.render(createElement(ForwardedControllerHarness, {
      ref: controllerRef,
      props: { ...props, preferredRepo: { name: 'project', localPath: '/project' } },
    })));
    await act(async () => Promise.resolve());

    expect(JSON.parse(container.firstElementChild?.getAttribute('data-sessions') ?? '[]')).toEqual([
      ['terminal-a', 'cortex-dash-a'],
      ['terminal-b', 'cortex-dash-b'],
    ]);
    expect(sendTerminalCreate).toHaveBeenCalledTimes(2);
  });

  it('starts a newly selected remote terminal after the workspace socket reconnects', async () => {
    const sendTerminalCreate = vi.fn<WorkspaceTerminalProps['sendTerminalCreate']>();
    const sendTerminalInput = vi.fn<WorkspaceTerminalProps['sendTerminalInput']>();
    const sendTerminalDetach = vi.fn<WorkspaceTerminalProps['sendTerminalDetach']>();
    const fetchMock = vi.mocked(fetch);
    const controllerRef = { current: null as TerminalTabHandle | null };
    const props: WorkspaceTerminalProps = {
      stateScope: 'remote-reconnect',
      defaultTab: 'terminal',
      autoCreateDefaultTab: false,
      sendTerminalCreate,
      sendTerminalAttach: vi.fn(),
      sendTerminalInput,
      sendTerminalResize: vi.fn(),
      sendTerminalVisibility: vi.fn(),
      sendTerminalDetach,
      termWsConnected: false,
    };
    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props })));
    await act(async () => Promise.resolve());
    let tabId = '';
    await act(async () => {
      tabId = controllerRef.current?.openRemoteTerminalTab({
        command: 'o8 machine attach fixture',
        machineId: '12345678-1234-1234-1234-123456789abc',
        machineLabel: 'Studio',
        sessionId: 'dash-1',
      }) ?? '';
    });
    expect(tabId).not.toBe('');
    expect(sendTerminalCreate).not.toHaveBeenCalled();

    await act(async () => root.render(createElement(ForwardedControllerHarness, { ref: controllerRef, props: { ...props, termWsConnected: true } })));
    const remoteRequest = sendTerminalCreate.mock.calls.find((call) => String(call[2]).includes(tabId));
    expect(remoteRequest).toBeDefined();
    expect(remoteRequest?.[5]).toBe(true);
    await act(async () => {
      expect(controllerRef.current?.onSessionCreated('remote-live-session', remoteRequest?.[2])).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/panel/terminal-exec', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionName: 'remote-live-session', command: 'o8 machine attach fixture' }),
    }));
    await act(async () => Promise.resolve());
    let closeRequest: TerminalCloseRequest | undefined;
    const stopConfirm = subscribeTerminalCloseConfirm((request) => { closeRequest = request; });
    await act(async () => expect(controllerRef.current?.closeActiveTab()).toBe(true));
    expect(sendTerminalInput).not.toHaveBeenCalled();
    expect(sendTerminalDetach).not.toHaveBeenCalled();
    expect(closeRequest?.tab.id).toBe(tabId);
    await act(async () => closeRequest?.resolve(true));
    stopConfirm();
    expect(sendTerminalInput).toHaveBeenCalledWith('remote-live-session', '\x1d');
    expect(sendTerminalDetach).toHaveBeenCalledWith('remote-live-session');
    expect(sendTerminalInput.mock.invocationCallOrder[0]).toBeLessThan(sendTerminalDetach.mock.invocationCallOrder[0]);
  });
});
