// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalTab } from './types';

vi.mock('@/components/desktop/workspace-terminal/XtermPanel', () => ({
  XtermPanel: ({ tmuxSession }: { tmuxSession: string }) => createElement('div', { 'data-tmux-session': tmuxSession }),
}));

vi.mock('@/components/desktop/workspace-terminal/WorkspaceChatPane', () => ({
  WorkspaceChatPane: () => null,
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

describe('WorkspaceTerminalPanels resident surface budget', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('mounts at most three heavy tab surfaces from a large restored workspace', async () => {
    const visibleTabs = Array.from({ length: 20 }, (_, index) => terminalTab(index));
    await act(async () => root.render(createElement(WorkspaceTerminalPanels, {
      visibleTabs,
      restoreSettled: true,
      effectiveActiveTabId: 'tab-0',
      termWsConnected: true,
      panelRefs: { current: new Map() },
      onCloseTab: vi.fn(),
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
    })));

    expect(container.querySelectorAll('[data-tmux-session]')).toHaveLength(3);
    expect(container.querySelector('[data-tmux-session="tmux-0"]')).not.toBeNull();
  });
});
