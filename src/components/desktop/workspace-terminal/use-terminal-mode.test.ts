// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { requestTerminalModeToggle } from '@/components/desktop/shell/TerminalModePill';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import type { RegisteredRepo, TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { useTerminalMode } from '@/components/desktop/workspace-terminal/use-terminal-mode';

type HookProps = Parameters<typeof useTerminalMode>[0];

const preferredRepo: RegisteredRepo = {
  name: 'repo',
  localPath: '/repo',
};

function chatTab(): TerminalTab {
  return {
    id: 'chat-before-mode',
    label: 'Coding session',
    kind: 'chat',
    tmuxSession: null,
    chatRuntime: 'codex',
    chatSessionKey: 'codex-owned:active',
    repo: preferredRepo,
    createdAt: 1,
    lastActivity: 1,
  };
}

function terminalTab(id = 'terminal-existing', session: string | null = 'existing-session'): TerminalTab {
  return {
    id,
    label: 'Terminal',
    kind: 'terminal',
    tmuxSession: session,
    repo: preferredRepo,
    createdAt: 2,
    lastActivity: 2,
  };
}

function TerminalModeHarness(props: HookProps) {
  const mode = useTerminalMode(props);
  return createElement('output', {
    'data-active': mode.active ? 'true' : 'false',
    'data-effective-tab-id': mode.effectiveActiveTabId,
    'data-terminal-tab-id': mode.terminalTab?.id ?? '',
  });
}

describe('useTerminalMode event toggle path', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: HookProps;
  let createShellTab: Mock<HookProps['createShellTab']>;
  let attachTerminalSession: Mock<HookProps['attachTerminalSession']>;
  let selectTab: Mock<HookProps['selectTab']>;
  let fitPanel: Mock<XtermPanelHandle['fit']>;
  let focusPanel: Mock<XtermPanelHandle['focus']>;
  let panelHandle: XtermPanelHandle;

  const render = (overrides: Partial<HookProps> = {}) => {
    props = { ...props, ...overrides };
    root.render(createElement(TerminalModeHarness, props));
  };

  const modeOutput = () => {
    const output = container.querySelector('output');
    if (!output) throw new Error('Terminal Mode harness did not render');
    return output;
  };

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createShellTab = vi.fn<HookProps['createShellTab']>(() => 'terminal-new');
    attachTerminalSession = vi.fn<HookProps['attachTerminalSession']>(() => 'terminal-attached');
    selectTab = vi.fn<HookProps['selectTab']>();
    fitPanel = vi.fn<XtermPanelHandle['fit']>();
    focusPanel = vi.fn<XtermPanelHandle['focus']>();
    panelHandle = {
      fit: fitPanel,
      focus: focusPanel,
      writeData: vi.fn(),
      writeRaw: vi.fn(),
      readText: vi.fn(() => ''),
      showImage: vi.fn(),
      setError: vi.fn(),
      setExited: vi.fn(),
    };
    const activeTab = chatTab();
    const terminal = terminalTab();
    props = {
      activeTab,
      activeTabId: activeTab.id,
      attachedSessions: [],
      canCloseTile: false,
      createShellTab,
      attachTerminalSession,
      panelRefs: { current: new Map([['existing-session', panelHandle]]) },
      preferredRepo,
      selectTab,
      tabs: [activeTab, terminal],
      workspaceActive: true,
      workspaceId: 'workspace-a',
    };
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    await act(async () => render());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('enters an existing terminal and restores the prior tab and focus on exit', async () => {
    const priorFocus = document.createElement('button');
    const terminalFocus = document.createElement('button');
    document.body.append(priorFocus, terminalFocus);
    priorFocus.focus();

    await act(async () => requestTerminalModeToggle('workspace-a'));

    expect(modeOutput().getAttribute('data-active')).toBe('true');
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('terminal-existing');
    expect(focusPanel).toHaveBeenCalledOnce();

    terminalFocus.focus();
    await act(async () => requestTerminalModeToggle('workspace-a'));

    expect(selectTab).toHaveBeenCalledWith('chat-before-mode');
    expect(modeOutput().getAttribute('data-active')).toBe('false');
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('chat-before-mode');
    expect(document.activeElement).toBe(priorFocus);
    priorFocus.remove();
    terminalFocus.remove();
  });

  it('fits and focuses once when a new shell receives its tmux session', async () => {
    const activeTab = chatTab();
    const pendingTerminal = terminalTab('terminal-new', null);
    await act(async () => render({ activeTab, tabs: [activeTab] }));

    await act(async () => {
      requestTerminalModeToggle('workspace-a');
      render({ tabs: [activeTab, pendingTerminal] });
    });

    expect(fitPanel).not.toHaveBeenCalled();
    expect(focusPanel).not.toHaveBeenCalled();

    const attachedTerminal = terminalTab('terminal-new', 'new-shell-session');
    props.panelRefs.current.set('new-shell-session', panelHandle);
    await act(async () => render({ tabs: [activeTab, attachedTerminal] }));

    expect(fitPanel).toHaveBeenCalledOnce();
    expect(focusPanel).toHaveBeenCalledOnce();

    await act(async () => render({ tabs: [activeTab, { ...attachedTerminal }] }));
    expect(fitPanel).toHaveBeenCalledOnce();
    expect(focusPanel).toHaveBeenCalledOnce();
  });

  it('creates a shell in the preferred repo and restores on the second toggle', async () => {
    const activeTab = chatTab();
    const createdTerminal = terminalTab('terminal-new', null);
    await act(async () => render({ activeTab, tabs: [activeTab] }));

    await act(async () => {
      requestTerminalModeToggle('workspace-a');
      render({ tabs: [activeTab, createdTerminal] });
    });

    expect(createShellTab).toHaveBeenCalledOnce();
    expect(createShellTab).toHaveBeenCalledWith(preferredRepo);
    expect(modeOutput().getAttribute('data-active')).toBe('true');
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('terminal-new');

    await act(async () => requestTerminalModeToggle('workspace-a'));
    expect(selectTab).toHaveBeenCalledWith('chat-before-mode');
    expect(modeOutput().getAttribute('data-active')).toBe('false');
  });

  it('attaches the active coding session without creating a shell', async () => {
    const activeTab = chatTab();
    const attachedSession = {
      sessionKey: 'codex-owned:active',
      tmuxSession: 'agent-session',
      label: 'Agent terminal',
      repo: preferredRepo,
    };
    const attachedTerminal = terminalTab('terminal-attached', attachedSession.tmuxSession);
    await act(async () => render({ activeTab, tabs: [activeTab], attachedSessions: [attachedSession] }));

    await act(async () => {
      requestTerminalModeToggle('workspace-a');
      render({ tabs: [activeTab, attachedTerminal] });
    });

    expect(attachTerminalSession).toHaveBeenCalledOnce();
    expect(attachTerminalSession).toHaveBeenCalledWith(attachedSession, preferredRepo);
    expect(createShellTab).not.toHaveBeenCalled();
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('terminal-attached');
  });

  it('ignores events for another workspace and untargeted events for an inactive split', async () => {
    await act(async () => render({ workspaceActive: false, canCloseTile: true }));

    await act(async () => requestTerminalModeToggle('workspace-b'));
    await act(async () => requestTerminalModeToggle());

    expect(modeOutput().getAttribute('data-active')).toBe('false');
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('chat-before-mode');
    expect(createShellTab).not.toHaveBeenCalled();
    expect(attachTerminalSession).not.toHaveBeenCalled();
    expect(selectTab).not.toHaveBeenCalled();
  });

  it('exits and restores the prior tab when the active terminal disappears', async () => {
    const activeTab = chatTab();
    await act(async () => requestTerminalModeToggle('workspace-a'));
    expect(modeOutput().getAttribute('data-active')).toBe('true');

    await act(async () => {
      render({ tabs: [activeTab] });
      await Promise.resolve();
    });
    await act(async () => Promise.resolve());

    expect(selectTab).toHaveBeenCalledWith('chat-before-mode');
    expect(modeOutput().getAttribute('data-active')).toBe('false');
    expect(modeOutput().getAttribute('data-effective-tab-id')).toBe('chat-before-mode');
  });
});
