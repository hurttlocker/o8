// @vitest-environment jsdom

import { act, createElement, useState, type ComponentProps, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchDetailsLauncher } from './BranchDetailsLauncher';
import { OrchestratorDataProvider, type OrchestratorDataValue } from './orchestrator-data-context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style, inert, 'aria-hidden': hidden }: HTMLAttributes<HTMLDivElement>) =>
  createElement('div', { style, inert, 'aria-hidden': hidden }, children) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true }));
vi.mock('./useBranchPr', () => ({ useBranchPr: () => null }));
vi.mock('./pr-panel/usePrDetail', () => ({ usePrDetail: () => ({ detail: null }) }));
vi.mock('./use-thread-sources', () => ({ useThreadSources: () => [] }));
vi.mock('./use-o8-browser-tabs', () => ({ useO8BrowserTabs: () => [] }));
vi.mock('./desktop-status-bar/footer-ports', () => ({ FooterPorts: () => null }));
vi.mock('./desktop-status-bar/supervisor-inbox-store', () => ({ useSupervisorInboxCount: () => 0, openSupervisorInboxTab: vi.fn() }));

describe('workspace details through the orchestrator rail', () => {
  let root: Root;
  let container: HTMLDivElement;
  let repo: string;
  let otherRepo: string;
  let sequence = 0;
  const fetchMock = vi.fn();
  const openPanel = vi.fn();
  const copy = vi.fn();
  const packet = (path: string) => ({ id: 'worker', workspaceTargetPath: path, branchTarget: 'worker/isolated', status: 'running', title: 'Worker task' }) as OrchestratorPacket;
  const details = () => document.querySelector<HTMLElement>('[data-workspace-details]')!;
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

  function Harness({ path, visible = true }: { path: string | null; visible?: boolean }) {
    const [collapsed, setCollapsed] = useState(true);
    const data = { agents: [], missionState: { packets: [packet(repo)] }, selectedPacketId: 'worker',
      workspaceTargets: [{ id: 'target', label: 'Sample repo', repoName: 'sample', localPath: repo, branch: 'stale-target' }],
      onMissionStateChange: vi.fn(), onOpenO8Panel: openPanel } as unknown as OrchestratorDataValue;
    return createElement(OrchestratorDataProvider, data as ComponentProps<typeof OrchestratorDataProvider>, createElement(BranchDetailsLauncher, {
      repoPath: path, visible, collapsed, onToggleCollapsed: () => setCollapsed(!collapsed),
    }));
  }
  const render = async (path: string | null = repo, visible = true) => {
    await act(async () => root.render(createElement(Harness, { path, visible })));
  };
  const open = async () => { await act(async () => button('Workspace details').click()); };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    repo = `/workspace/rail-${++sequence}`;
    otherRepo = `${repo}-other`;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy.mockResolvedValue(undefined) } });
    openPanel.mockReset(); fetchMock.mockReset(); copy.mockClear();
    fetchMock.mockImplementation(async () => Response.json({ changedFiles: [{ path: 'file.ts', additions: 3, deletions: 1 }], branch: 'chat/actual', repoSlug: 'org/sample',
      worktrees: [{ path: '~/sample', absolutePath: '/workspace/main-checkout', branch: 'main', isCurrent: false },
        { path: '~/current', absolutePath: repo, branch: 'chat/actual', isCurrent: true },
        { path: '~/review copy', absolutePath: '/workspace/review copy', branch: 'feature/other', isCurrent: false },
        { path: '~/gone', absolutePath: '/workspace/gone', branch: 'old', isCurrent: false, prunableReason: 'Missing checkout' },
        { path: '~/detached', absolutePath: '/workspace/detached', isDetached: true, head: 'abc1234', isCurrent: false }],
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    act(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  it('shows the chat checkout and real Git branch, and opens each worktree only in Files', async () => {
    await render(); await open();
    expect(details().textContent).toContain('sampleWorktreechat/actual');
    expect(details().textContent).not.toContain('worker/isolated');
    expect(details().textContent).not.toContain('stale-target');
    expect(details().textContent).not.toContain('Create pull request');
    await act(async () => Array.from(details().querySelectorAll('button')).find(el => el.textContent === 'Files')!.click());
    expect(openPanel).toHaveBeenLastCalledWith({ repoPath: repo, tab: 'files' });
    await act(async () => Array.from(details().querySelectorAll('button')).find(el => el.textContent?.includes('Changes'))!.click());
    expect(openPanel).toHaveBeenLastCalledWith({ repoPath: repo, tab: 'workspace' });
    await act(async () => details().querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(details().textContent).toContain('This chat');
    expect(details().textContent).toContain('Detached · abc1234');
    expect(button('Browse old files').disabled).toBe(true);
    await act(async () => button('Browse feature/other files').click());
    expect(openPanel).toHaveBeenLastCalledWith({ repoPath: '/workspace/review copy', tab: 'files' });
    expect(details().querySelector('[data-workspace-context]')?.textContent).toContain('chat/actual');
    await act(async () => button('Copy workspace path').click());
    expect(copy).toHaveBeenCalledWith(repo);
  });

  it('removes hidden controls from keyboard navigation and handles Escape', async () => {
    await render();
    expect(details().hasAttribute('inert')).toBe(true);
    expect(details().getAttribute('aria-hidden')).toBe('true');
    await open();
    expect(details().hasAttribute('inert')).toBe(false);
    expect(button('Workspace details').closest('[inert]')).not.toBeNull();
    await act(async () => button('Hide workspace details').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(details().hasAttribute('inert')).toBe(true);
    expect(button('Workspace details').getAttribute('aria-expanded')).toBe('false');
    await render(repo, false);
    expect(document.querySelector('[data-workspace-details]')).toBeNull();
  });

  it('focuses the opened card in its own pane when two cards are visible', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return 1; });
    await act(async () => root.render(createElement('div', null,
      createElement(Harness, { path: repo }), createElement(Harness, { path: otherRepo }),
    )));
    const triggers = container.querySelectorAll<HTMLButtonElement>('[aria-label="Workspace details"]');
    await act(async () => triggers[0].click());
    frames[0](0);
    const nextFrame = frames.length;
    await act(async () => triggers[1].click());
    frames[nextFrame](0);
    const panels = document.querySelectorAll('[data-workspace-details]');
    expect(document.activeElement?.closest('[data-workspace-details]')).toBe(panels[1]);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Hide workspace details');
  });

  it('does not show a late reply from the previous repo after a scope change', async () => {
    let respond!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }));
    await render(); await open();
    expect(details().textContent).toContain('Reading Git context');
    await render(otherRepo);
    await act(async () => respond(Response.json({ branch: 'foreign-late', repoSlug: 'org/foreign', changedFiles: [],
      worktrees: [{ path: '/foreign', absolutePath: '/foreign', isCurrent: true }] })));
    expect(details().textContent).toContain('chat/actual');
    expect(details().textContent).not.toContain('foreign');
    expect(fetchMock).toHaveBeenCalledWith(`/api/review/workspace?workspace=${encodeURIComponent(otherRepo)}&changesOnly=1`);
  });

  it('gives errors a retry and keeps Home free of a foreign project', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Offline'));
    await render(); await open();
    expect(details().textContent).toContain('Git context couldn’t load');
    expect(details().textContent).not.toContain('Working tree clean');
    await act(async () => Array.from(details().querySelectorAll('button')).find(el => el.textContent === 'Retry')!.click());
    expect(details().textContent).toContain('chat/actual');
    await render(null);
    expect(details().textContent).toContain('This chat has no project attached');
    expect(details().textContent).not.toContain('Worker task');
    expect(details().textContent).not.toContain('chat/actual');
  });
});
