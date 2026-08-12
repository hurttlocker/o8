// @vitest-environment jsdom

import { act, createElement, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  queueOutsideWorkerSplit,
  resetOutsideWorkerSplitsForTest,
} from '@/lib/orchestrator/outside-worker-split';
import type { RegisteredRepo, TerminalTab } from './types';
import { useOutsideWorkerSplitMount } from './use-outside-worker-split-mount';
import { useSessionTiles } from './use-session-tiles';

function Consumer(props: {
  repoPath: string;
  workspaceId: string;
  threadId: string;
  retiredSessionKeys?: ReadonlySet<string>;
}) {
  const sessions = useSessionTiles({
    tabId: 'orchestrator-consumer',
    active: true,
    repoPath: props.repoPath,
    workspaceId: props.workspaceId,
    threadId: props.threadId,
    liveSessionKeys: [],
    retiredSessionKeys: props.retiredSessionKeys,
  }).tiledSessions;
  return createElement('output', { 'data-sessions': sessions.join(',') });
}

function RotationConsumer() {
  const sessionTiles = useSessionTiles({
    tabId: 'rotation-consumer',
    active: true,
    repoPath: '/repo/one',
    workspaceId: 'workspace-one',
    threadId: 'thoughts-one',
    liveSessionKeys: [],
  });
  const outsideLeaf = sessionTiles.sessionLeaves.find((leaf) => leaf.participantId === 'packet-two');
  return createElement('div', null,
    createElement('button', {
      type: 'button',
      'data-focus-second': true,
      onClick: () => sessionTiles.setFocusedSessionKey('codex-owned:old-two'),
    }),
    createElement('output', {
      'data-sessions': sessionTiles.tiledSessions.join(','),
      'data-focused': sessionTiles.focusedSessionKey ?? '',
      'data-leaves': sessionTiles.sessionLeaves.map((leaf) => (
        `${leaf.participantId ?? ''}:${leaf.id}:${leaf.arrivalOrder ?? ''}`
      )).join(','),
      'data-outside-truth': [
        outsideLeaf?.repoPath,
        outsideLeaf?.runtime,
        outsideLeaf?.title,
        outsideLeaf?.launchContext?.source,
        outsideLeaf?.launchContext?.caller,
      ].join('|'),
    }),
  );
}

function VisibleOutsideWorker({
  active,
  workspaceId,
  tab,
}: {
  active: boolean;
  workspaceId: string;
  tab: TerminalTab;
}) {
  const sessionTiles = useSessionTiles({
    tabId: tab.id,
    active,
    repoPath: tab.repo?.localPath ?? '',
    workspaceId,
    threadId: tab.orchestratorThreadId,
    liveSessionKeys: [],
  });
  return createElement('output', {
    'data-visible-repo': tab.repo?.localPath ?? '',
    'data-visible-sessions': sessionTiles.tiledSessions.join(','),
  });
}

function MountingSurface({
  active = true,
  activeTabId: initialActiveTabId = '',
  initialTabs = [],
  workspaceId,
}: {
  active?: boolean;
  activeTabId?: string;
  initialTabs?: TerminalTab[];
  workspaceId: string;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState(initialActiveTabId);
  const tabsRef = useRef<TerminalTab[]>(initialTabs);
  const nextTabIdRef = useRef(1);
  const spawnOrchestratorTab = useCallback((
    repo?: RegisteredRepo | null,
    forceFresh = false,
    outsideWorkerHost = false,
  ) => {
    const reusable = forceFresh ? null : tabsRef.current.find((tab) => (
      tab.kind === 'orchestrator' && !tab.orchestratorThreadId
    )) ?? null;
    if (reusable) {
      const nextTabs = tabsRef.current.map((tab) => (
        tab.id === reusable.id ? { ...tab, repo: repo ?? undefined } : tab
      ));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveTabId(reusable.id);
      return reusable.id;
    }
    const id = `mounted-outside-tab-${nextTabIdRef.current++}`;
    const nextTabs = [...tabsRef.current, {
      id,
      label: 'Orchestrator',
      kind: 'orchestrator',
      tmuxSession: null,
      repo: repo ?? undefined,
      createdAt: 1,
      lastActivity: 1,
      outsideWorkerHost,
    } satisfies TerminalTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabId(id);
    return id;
  }, []);
  useOutsideWorkerSplitMount({
    active,
    activeTabId,
    workspaceId,
    tabs,
    selectTab: setActiveTabId,
    spawnOrchestratorTab,
  });
  if (tabs.length === 0) {
    return createElement('output', { 'data-visible-repo': '', 'data-visible-sessions': '' });
  }
  return createElement('div', null, tabs.map((tab) => createElement('section', {
    key: tab.id,
    'data-mounted-tab': tab.id,
    'data-outside-worker-host': tab.outsideWorkerHost ? 'true' : 'false',
  },
  createElement('button', {
    type: 'button',
    'data-select-repo': tab.repo?.localPath ?? '',
    onClick: () => setActiveTabId(tab.id),
  }),
  createElement(VisibleOutsideWorker, {
    active: tab.id === activeTabId,
    workspaceId,
    tab,
  }))));
}

describe('outside worker split hook consumer path', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetOutsideWorkerSplitsForTest();
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetOutsideWorkerSplitsForTest();
    container.remove();
  });

  it('passes the live repo, workspace, and thread through before adopting a split', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:placed',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-one',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thoughts-one',
      },
    });

    await act(async () => root.render(createElement(Consumer, {
      repoPath: '/repo/two',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })));
    expect(container.querySelector('output')?.getAttribute('data-sessions')).toBe('');

    await act(async () => root.render(createElement(Consumer, {
      repoPath: '/repo/one',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })));
    expect(container.querySelector('output')?.getAttribute('data-sessions')).toBe('codex-owned:placed');
  });

  it('mounts an unopened transient repo and adopts its queued worker', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:transient',
      runtime: 'opencode',
      repoPath: '/outside/transient-repo',
      packetId: 'packet-transient',
      laneId: 'lane-transient',
      title: 'Inspect transient repo',
      launchContext: {
        source: 'cli',
        presentation: 'split',
        repoContext: 'transient',
      },
    });

    await act(async () => root.render(createElement(MountingSurface, {
      workspaceId: 'workspace-fallback',
    })));

    const output = container.querySelector('output');
    expect(output?.getAttribute('data-visible-repo')).toBe('/outside/transient-repo');
    expect(output?.getAttribute('data-visible-sessions')).toBe('opencode-owned:transient');
    expect(container.querySelector('[data-outside-worker-host="true"]')).not.toBeNull();
  });

  it('gives concurrent unopened repos distinct mount surfaces', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:repo-a',
      runtime: 'codex',
      repoPath: '/outside/repo-a',
      packetId: 'packet-repo-a',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:repo-b',
      runtime: 'opencode',
      repoPath: '/outside/repo-b',
      packetId: 'packet-repo-b',
    });

    await act(async () => root.render(createElement(MountingSurface, {
      workspaceId: 'workspace-fallback',
    })));

    const mountedRepos = [...container.querySelectorAll('output')].map((output) => (
      output.getAttribute('data-visible-repo')
    ));
    expect(mountedRepos).toEqual(['/outside/repo-a', '/outside/repo-b']);
    expect(container.querySelector('[data-visible-repo="/outside/repo-b"]')
      ?.getAttribute('data-visible-sessions')).toBe('opencode-owned:repo-b');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-select-repo="/outside/repo-a"]')?.click();
    });
    expect(container.querySelector('[data-visible-repo="/outside/repo-a"]')
      ?.getAttribute('data-visible-sessions')).toBe('codex-owned:repo-a');
  });

  it('groups concurrent workers for one unopened repo in the same host mesh', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:same-repo-a',
      runtime: 'codex',
      repoPath: '/outside/same-repo',
      packetId: 'packet-same-repo-a',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:same-repo-b',
      runtime: 'opencode',
      repoPath: '/outside/same-repo',
      packetId: 'packet-same-repo-b',
    });

    await act(async () => root.render(createElement(MountingSurface, {
      workspaceId: 'workspace-fallback',
    })));

    expect(container.querySelectorAll('[data-mounted-tab]')).toHaveLength(1);
    expect(container.querySelector('[data-visible-repo="/outside/same-repo"]')
      ?.getAttribute('data-visible-sessions')).toBe(
        'codex-owned:same-repo-a,opencode-owned:same-repo-b',
      );
  });

  it('places a parentless worker beside the active same-repo orchestrator chat', async () => {
    const repo = { localPath: '/outside/same-repo', name: 'same-repo' };
    const initialTabs = [
      { id: 'older-chat', label: 'Older', kind: 'orchestrator', tmuxSession: null, repo, createdAt: 1, lastActivity: 1 },
      { id: 'active-chat', label: 'Active', kind: 'orchestrator', tmuxSession: null, repo, createdAt: 2, lastActivity: 2 },
    ] satisfies TerminalTab[];
    await act(async () => root.render(createElement(MountingSurface, {
      activeTabId: 'active-chat',
      initialTabs,
      workspaceId: 'workspace-active-chat',
    })));

    await act(async () => queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:active-chat',
      runtime: 'codex',
      repoPath: repo.localPath,
      packetId: 'packet-active-chat',
    }));

    expect(container.querySelector('[data-mounted-tab="older-chat"] output')
      ?.getAttribute('data-visible-sessions')).toBe('');
    expect(container.querySelector('[data-mounted-tab="active-chat"] output')
      ?.getAttribute('data-visible-sessions')).toBe('codex-owned:active-chat');
  });

  it('mounts a parentless unopened repo beside the active workspace', async () => {
    await act(async () => root.render(createElement('div', null,
      createElement('section', { 'data-surface': 'inactive' }, createElement(MountingSurface, {
        active: false,
        workspaceId: 'workspace-a',
      })),
      createElement('section', { 'data-surface': 'active' }, createElement(MountingSurface, {
        active: true,
        workspaceId: 'workspace-z',
      })),
    )));

    await act(async () => queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:active-surface',
      runtime: 'codex',
      repoPath: '/outside/active-surface',
      packetId: 'packet-active-surface',
    }));

    expect(container.querySelector('[data-surface="inactive"] output')
      ?.getAttribute('data-visible-repo')).toBe('');
    expect(container.querySelector('[data-surface="active"] output')
      ?.getAttribute('data-visible-repo')).toBe('/outside/active-surface');
  });

  it('retires a claimed pane from the correlated archived lane event', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'opencode-owned:reset-retired',
      runtime: 'opencode',
      repoPath: '/repo/one',
      packetId: 'packet-reset-retired',
      laneId: 'lane-reset-retired',
    });
    await act(async () => root.render(createElement(Consumer, {
      repoPath: '/repo/one',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })));
    const output = container.querySelector('output');
    expect(output?.getAttribute('data-sessions')).toBe('opencode-owned:reset-retired');

    await act(async () => {
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle', {
        detail: {
          data: {
            laneId: 'lane-reset-retired',
            sessionKey: 'opencode-owned:reset-retired',
            status: 'archived',
          },
        },
      }));
    });

    expect(output?.getAttribute('data-sessions')).toBe('');
  });

  it('removes a broker claim through the persisted retired-session fallback', async () => {
    const sessionKey = 'opencode-owned:persisted-retired';
    queueOutsideWorkerSplit({
      sessionKey,
      runtime: 'opencode',
      repoPath: '/repo/one',
      packetId: 'packet-persisted-retired',
      laneId: 'lane-persisted-retired',
    });
    await act(async () => root.render(createElement(Consumer, {
      repoPath: '/repo/one',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })));
    expect(container.querySelector('output')?.getAttribute('data-sessions')).toBe(sessionKey);

    await act(async () => {
      root.render(createElement(Consumer, {
        repoPath: '/repo/one',
        workspaceId: 'workspace-one',
        threadId: 'thoughts-one',
        retiredSessionKeys: new Set([sessionKey]),
      }));
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 10)));
    expect(container.querySelector('output')?.getAttribute('data-sessions')).toBe('');

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(Consumer, {
      repoPath: '/repo/one',
      workspaceId: 'workspace-one',
      threadId: 'thoughts-one',
    })));

    expect(container.querySelector('output')?.getAttribute('data-sessions')).toBe('');
  });

  it('keeps a focused non-first leaf through rotation and ignores retirement of its old key', async () => {
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:first',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-one',
      laneId: 'lane-one',
    });
    queueOutsideWorkerSplit({
      sessionKey: 'codex-owned:old-two',
      runtime: 'codex',
      repoPath: '/repo/one',
      packetId: 'packet-two',
      laneId: 'lane-two',
      title: 'Inspect outside repo',
      launchContext: {
        source: 'cli',
        presentation: 'split',
        repoContext: 'transient',
        caller: 'outside terminal',
        parentWorkspaceId: 'workspace-one',
        parentThreadId: 'thoughts-one',
      },
    });
    await act(async () => root.render(createElement(RotationConsumer)));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-focus-second]')?.click();
    });
    const initialLeaves = container.querySelector('output')?.getAttribute('data-leaves');
    expect(container.querySelector('output')?.getAttribute('data-focused')).toBe('codex-owned:old-two');

    await act(async () => {
      queueOutsideWorkerSplit({
        sessionKey: 'codex-owned:new-two',
        runtime: 'codex',
        repoPath: '/repo/one',
        laneId: 'lane-two',
      });
    });

    const output = container.querySelector('output');
    expect(output?.getAttribute('data-sessions')).toBe('codex-owned:first,codex-owned:new-two');
    expect(output?.getAttribute('data-focused')).toBe('codex-owned:new-two');
    expect(output?.getAttribute('data-leaves')).toBe(initialLeaves);
    expect(output?.getAttribute('data-outside-truth')).toBe(
      '/repo/one|codex|Inspect outside repo|cli|outside terminal',
    );

    await act(async () => {
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle', {
        detail: {
          data: {
            laneId: 'lane-two',
            sessionKey: 'codex-owned:old-two',
            status: 'completed',
          },
        },
      }));
    });

    expect(output?.getAttribute('data-sessions')).toBe('codex-owned:first,codex-owned:new-two');
    expect(output?.getAttribute('data-focused')).toBe('codex-owned:new-two');
  });
});
