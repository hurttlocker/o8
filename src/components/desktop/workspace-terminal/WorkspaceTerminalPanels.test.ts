// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTab } from './types';
import {
  queueOutsideWorkerSplit,
  resetOutsideWorkerSplitsForTest,
} from '@/lib/orchestrator/outside-worker-split';
import { useSessionTiles } from './use-session-tiles';

const xtermMockState = vi.hoisted(() => ({ mounts: 0 }));

vi.mock('@/components/desktop/workspace-terminal/XtermPanel', async () => {
  const { createElement: mockCreateElement, useEffect } = await import('react');
  return {
    XtermPanel: ({
      tmuxSession,
      visible,
      sendTerminalAttach,
      sendTerminalDetach,
    }: {
      tmuxSession: string;
      visible: boolean;
      sendTerminalAttach: (session: string, cols: number, rows: number) => void;
      sendTerminalDetach: (session: string) => void;
    }) => {
      useEffect(() => {
        xtermMockState.mounts += 1;
        sendTerminalAttach(tmuxSession, 120, 30);
        return () => sendTerminalDetach(tmuxSession);
      }, [sendTerminalAttach, sendTerminalDetach, tmuxSession]);
      return mockCreateElement('div', {
        'data-tmux-session': tmuxSession,
        'data-visible': visible ? 'true' : 'false',
      });
    },
  };
});

vi.mock('@/components/desktop/workspace-terminal/WorkspaceChatPane', () => ({
  WorkspaceChatPane: ({ tab, active }: { tab: TerminalTab; active: boolean }) => createElement('div', {
    'data-chat-tab': tab.id,
    'data-active': active ? 'true' : 'false',
  }),
}));

vi.mock('@/components/desktop/workspace-terminal/workspace-boot-loader-claim', () => ({
  WorkspaceBootLoaderClaim: () => null,
}));

vi.mock('@/lib/react/retrying-lazy', () => ({
  retryingLazy: () => () => null,
}));

import { WorkspaceTerminalPanels } from './WorkspaceTerminalPanels';

function terminalTab(index: number): TerminalTab {
  return {
    id: `tab-${index}`,
    label: `Terminal ${index}`,
    kind: 'terminal',
    tmuxSession: `tmux-${index}`,
    createdAt: index,
    lastActivity: index,
  } as unknown as TerminalTab;
}

const ACTIVE_RETIRED_KEYS = new Set(['opencode-owned:auto-host']);
const NO_RETIRED_KEYS = new Set<string>();

function OutsideWorkerLifecycle({ retired }: { retired: boolean }) {
  useSessionTiles({
    tabId: 'outside-host',
    active: true,
    repoPath: '/outside/repo',
    workspaceId: 'workspace-test',
    threadId: null,
    liveSessionKeys: [],
    retiredSessionKeys: retired ? ACTIVE_RETIRED_KEYS : NO_RETIRED_KEYS,
  });
  return null;
}

function panelProps(visibleTabs: TerminalTab[], onCloseTab = vi.fn()) {
  return {
    workspaceId: 'workspace-test',
    visibleTabs,
    restoreSettled: true,
    effectiveActiveTabId: visibleTabs[0]?.id ?? '',
    termWsConnected: true,
    panelRefs: { current: new Map() },
    onCloseTab,
    onRunInTerminal: vi.fn(),
    onOpenWorkspaceCommitTab: vi.fn(),
    onUpdateLlmSummary: vi.fn(),
    onUpdateLinkedIssue: vi.fn(),
    onUpdateChatMessages: vi.fn(),
    onUpdateChatSessionKey: vi.fn(),
    onUpdateChatModel: vi.fn(),
    onConsumeChatDraftInjection: vi.fn(),
    onSaveCheckpoint: vi.fn(),
    onRestoreLatestCheckpoint: vi.fn(),
    projectContextRailVisible: false,
    sendTerminalAttach: vi.fn(),
    sendTerminalInput: vi.fn(),
    sendTerminalResize: vi.fn(),
    sendTerminalDetach: vi.fn(),
  };
}

describe('WorkspaceTerminalPanels resident surface budget', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetOutsideWorkerSplitsForTest();
    xtermMockState.mounts = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetOutsideWorkerSplitsForTest();
    container.remove();
  });

  it('mounts at most three heavy tab surfaces from a large restored workspace', async () => {
    const visibleTabs = Array.from({ length: 20 }, (_, index) => terminalTab(index));
    await act(async () => root.render(createElement(WorkspaceTerminalPanels, panelProps(visibleTabs))));

    expect(container.querySelectorAll('[data-tmux-session]')).toHaveLength(3);
    expect(container.querySelector('[data-tmux-session="tmux-0"]')).not.toBeNull();
  });

  it('enters and exits Terminal Mode 100 times without replacing the resident XtermPanel', async () => {
    const previousTab = {
      id: 'chat-before-mode',
      label: 'Coding session',
      kind: 'chat',
      tmuxSession: null,
      chatRuntime: 'codex',
      createdAt: 1,
      lastActivity: 1,
    } satisfies TerminalTab;
    const terminal = terminalTab(1);
    const props = panelProps([previousTab, terminal]);
    const renderActive = (effectiveActiveTabId: string) => root.render(createElement(WorkspaceTerminalPanels, {
      ...props,
      effectiveActiveTabId,
    }));

    await act(async () => renderActive(previousTab.id));
    expect(xtermMockState.mounts).toBe(1);
    expect(props.sendTerminalAttach).toHaveBeenCalledOnce();
    props.sendTerminalAttach.mockClear();
    props.sendTerminalDetach.mockClear();

    for (let index = 0; index < 100; index += 1) {
      await act(async () => renderActive(terminal.id));
      await act(async () => renderActive(previousTab.id));
    }

    expect(xtermMockState.mounts).toBe(1);
    expect(container.querySelectorAll('[data-tmux-session="tmux-1"]')).toHaveLength(1);
    expect(container.querySelector('[data-tmux-session="tmux-1"]')?.getAttribute('data-visible')).toBe('false');
    expect(container.querySelector('[data-chat-tab="chat-before-mode"]')?.getAttribute('data-active')).toBe('true');
    expect(props.sendTerminalAttach).not.toHaveBeenCalled();
    expect(props.sendTerminalDetach).not.toHaveBeenCalled();
  });

  it('closes an automatic outside-worker host after its last durable leaf retires', async () => {
    const onCloseTab = vi.fn();
    const outsideHost = {
      id: 'outside-host',
      label: 'Orchestrator',
      kind: 'orchestrator',
      tmuxSession: null,
      repo: { localPath: '/outside/repo', name: 'repo' },
      createdAt: 1,
      lastActivity: 1,
      outsideWorkerHost: true,
    } satisfies TerminalTab;
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:auto-host',
      runtime: 'opencode',
      repoPath: '/outside/repo',
      packetId: 'packet-auto-host',
      laneId: 'lane-auto-host',
    });

    const render = (retired: boolean) => root.render(createElement(Fragment, null,
      createElement(WorkspaceTerminalPanels, panelProps([outsideHost], onCloseTab)),
      createElement(OutsideWorkerLifecycle, { retired }),
    ));
    await act(async () => render(false));
    expect(onCloseTab).not.toHaveBeenCalled();

    await act(async () => render(true));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)));
    expect(onCloseTab).toHaveBeenCalledOnce();
    expect(onCloseTab).toHaveBeenCalledWith('outside-host');
  });

  it('keeps an outside-worker host once it owns an operator conversation', async () => {
    const onCloseTab = vi.fn();
    const usedOutsideHost = {
      id: 'outside-host',
      label: 'Orchestrator',
      kind: 'orchestrator',
      tmuxSession: null,
      repo: { localPath: '/outside/repo', name: 'repo' },
      createdAt: 1,
      lastActivity: 1,
      outsideWorkerHost: true,
      orchestratorThreadId: 'thoughts-used-host',
    } satisfies TerminalTab;
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:auto-host',
      runtime: 'opencode',
      repoPath: '/outside/repo',
      packetId: 'packet-auto-host',
      laneId: 'lane-auto-host',
    });

    const render = (retired: boolean) => root.render(createElement(Fragment, null,
      createElement(WorkspaceTerminalPanels, panelProps([usedOutsideHost], onCloseTab)),
      createElement(OutsideWorkerLifecycle, { retired }),
    ));
    await act(async () => render(false));
    await act(async () => render(true));
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)));

    expect(onCloseTab).not.toHaveBeenCalled();
  });
});
