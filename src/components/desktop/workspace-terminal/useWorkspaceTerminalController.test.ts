// @vitest-environment jsdom

import { act, createElement, forwardRef, type ForwardedRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTabHandle, WorkspaceTerminalProps } from './types';

const restoreHarness = vi.hoisted(() => ({
  resolveValidated: null as null | ((value: unknown) => void),
  validatedPromise: null as Promise<unknown> | null,
}));

vi.mock('./terminal-restore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./terminal-restore')>();
  const restoredTabs = () => ([
    {
      id: 'terminal-a', label: 'Terminal A', kind: 'terminal', tmuxSession: null,
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
    deadTerminalTabs: restoredTabs(),
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
    computeRestoredTabs: vi.fn(async (_saved, _options, _cancelled, mode) => (
      mode === 'optimistic' ? result() : restoreHarness.validatedPromise
    )),
  };
});

vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));
vi.mock('./orchestrator-thread-restore', () => ({ readLastOrchestratorThreadTitle: vi.fn(async () => null) }));

import { useWorkspaceTerminalController } from './useWorkspaceTerminalController';

function ControllerHarness({
  controllerRef,
  props,
}: {
  controllerRef: ForwardedRef<TerminalTabHandle>;
  props: WorkspaceTerminalProps;
}) {
  const controller = useWorkspaceTerminalController(props, controllerRef);
  return createElement('div', {
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
});
