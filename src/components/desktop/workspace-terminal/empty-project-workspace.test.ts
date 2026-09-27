// @vitest-environment jsdom
import { act, createElement, forwardRef, useCallback, useImperativeHandle, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useWorkspacePageLayouts } from '@/app/dashboard/hooks/useWorkspacePageLayouts';
import { collectLeafNodes, replaceTileContent } from '@/lib/tiles/operations';
import type { TileLayout } from '@/lib/tiles/types';
import type { PersistedTabState } from '@/lib/terminal/tab-state';
import { useWorkspaceTerminalController } from './useWorkspaceTerminalController';
import { OrchestratorTab } from './OrchestratorTab';

const h = vi.hoisted(() => ({ load: vi.fn(), attach: vi.fn(), create: vi.fn(), detach: vi.fn() }));
vi.mock('@/lib/operator/use-experimental-chat', () => ({ useExperimentalChatFlag: () => false }));
vi.mock('@/lib/operator/use-experimental-canvas', () => ({ useExperimentalCanvasFlag: () => false }));
vi.mock('@/components/desktop/orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] }, workspaceTargets: [] }) }));
vi.mock('@/components/desktop/thoughts/ThoughtsChatPanel', () => ({
  ThoughtsChatPanel: forwardRef(function Panel({ emptyStateOverride }: { emptyStateOverride: ReactNode }, ref) {
    useImperativeHandle(ref, () => ({ loadThread: h.load, focusInput: () => undefined }));
    return createElement('div', null, emptyStateOverride);
  }),
}));
vi.mock('@/components/desktop/OrchestratorEmptyState', () => ({
  OrchestratorEmptyState: ({ onSelectProject }: { onSelectProject: (repo: { localPath: string; repoName: string }) => void }) => createElement('button', { onClick: () => onSelectProject({ localPath: '/repo/selected', repoName: 'selected' }) }, 'Select project'),
  OrchestratorStartLocationControls: () => null,
}));
vi.mock('./ResponsiveSessionSurface', () => ({ ResponsiveSessionSurface: ({ chatSlot }: { chatSlot: ReactNode }) => chatSlot }));
vi.mock('@/components/desktop/orchestrator/OrchestratorRunStrip', () => ({ OrchestratorRunStrip: () => null }));
vi.mock('@/components/desktop/orchestrator/OrchestratorPromptControls', () => ({ OrchestratorPromptControls: () => null }));

const initialLayout: TileLayout = { version: 4, root: { type: 'split', id: 'split', direction: 'vertical', ratio: 1 / 3, children: [
  { type: 'leaf', id: 'tile-root', content: { kind: 'terminal', repoPath: '/repo/original' } },
  { type: 'split', id: 'right', direction: 'vertical', ratio: 0.5, children: [
    { type: 'leaf', id: 'terminal-a', content: { kind: 'terminal', createdFromSplit: true, initialTab: 'terminal' } },
    { type: 'leaf', id: 'terminal-b', content: { kind: 'terminal', createdFromSplit: true, initialTab: 'terminal' } },
  ] },
] } };
const noOp = () => undefined;
const terminalProps = { sendTerminalCreate: h.create, sendTerminalAttach: h.attach, sendTerminalInput: noOp, sendTerminalResize: noOp, sendTerminalVisibility: noOp, sendTerminalDetach: h.detach, termWsConnected: true };
function Terminal({ id }: { id: string }) {
  const c = useWorkspaceTerminalController({ ...terminalProps, stateScope: id, splitCreated: true, defaultTab: 'terminal' }, null);
  return createElement('output', { 'data-terminal': id }, c.tabs.map((tab) => tab.tmuxSession).join(','));
}
let bootRepo = '/repo/original';
function Workspace() {
  const [repo, setRepo] = useState(bootRepo);
  const [layout, setLayout] = useState(initialLayout);
  const onRepoScopeChange = useCallback((path: string | null) => {
    if (!path) return;
    setRepo(path);
    setLayout((current) => ({
      ...current,
      root: replaceTileContent(current.root, 'tile-root', { kind: 'terminal', repoPath: path }),
    }));
  }, []);
  const c = useWorkspaceTerminalController({ ...terminalProps, stateScope: 'tile-root', defaultTab: 'llm-chat', preferredRepo: { name: 'repo', localPath: repo }, onRepoScopeChange }, null);
  const [, setActiveTileId] = useState<string | null>('tile-root');
  useWorkspacePageLayouts({ activeTabId: c.effectiveActiveTabId, hydrated: c.tabs.length > 0, layout, setLayout, setActiveTileId });
  const tab = c.tabs.find((entry) => entry.id === c.effectiveActiveTabId);
  return createElement('div', { 'data-active-tab': tab?.id, 'data-repo': tab?.repo?.localPath },
    tab ? createElement(OrchestratorTab, { tabId: tab.id, workspaceId: 'tile-root', active: true, repoPath: tab.repo?.localPath, restoreLastThread: !tab.freshSpawn, initialThreadId: tab.orchestratorThreadId }) : null,
    ...collectLeafNodes(layout.root).filter((leaf) => leaf.id !== 'tile-root').map((leaf) => createElement(Terminal, { key: leaf.id, id: leaf.id })),
  );
}

it('keeps an explicitly selected unsent chat and its terminal panes across reload', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  bootRepo = '/repo/original';
  localStorage.clear();
  localStorage.setItem('o8:last-orchestrator-thread-id::/repo/selected', 'thoughts-older-chat');
  const saved = new Map<string, PersistedTabState>();
  for (const id of ['terminal-a', 'terminal-b']) saved.set(id, { version: 1, activeTabId: `tab-${id}`, tabs: [{ id: `tab-${id}`, label: 'Shell', kind: 'terminal', cliAgent: 'shell', tmuxSession: `cortex-dash-${id}` }], savedAt: new Date(0).toISOString() });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/panel/terminal-state') {
      const scope = url.searchParams.get('scope') ?? 'tile-root';
      if (init?.method === 'POST') { saved.set(scope, JSON.parse(String(init.body))); return Response.json({ ok: true }); }
      return saved.has(scope) ? Response.json(saved.get(scope)) : new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/panel/terminal-sessions') return Response.json({ sessions: ['cortex-dash-terminal-a', 'cortex-dash-terminal-b'] });
    return Response.json({ conversations: [], paths: [] });
  }));
  const host = document.createElement('div'); document.body.append(host);
  let root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Workspace)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const originalId = host.firstElementChild?.getAttribute('data-active-tab');
    expect(originalId).toBeTruthy();
    expect(host.querySelectorAll('[data-terminal]')).toHaveLength(2);
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(h.load).not.toHaveBeenCalled();
    expect(host.firstElementChild?.getAttribute('data-active-tab')).toBe(originalId);
    expect(host.firstElementChild?.getAttribute('data-repo')).toBe('/repo/selected');
    expect(host.querySelector('[data-terminal="terminal-a"]')?.textContent).toBe('cortex-dash-terminal-a');
    expect(host.querySelector('[data-terminal="terminal-b"]')?.textContent).toBe('cortex-dash-terminal-b');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.detach).not.toHaveBeenCalled();
    expect(saved.get('tile-root')?.tabs.find((tab) => tab.id === originalId)?.repoPath).toBe('/repo/selected');
    const pages = JSON.parse(localStorage.getItem('o8:dashboard-page-layouts:v1') ?? '{}');
    expect(collectLeafNodes(JSON.parse(pages[originalId!]).root)).toHaveLength(3);
    await act(async () => root.unmount());
    bootRepo = '/repo/selected';
    root = createRoot(host);
    await act(async () => root.render(createElement(Workspace)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1000)); });
    expect(host.firstElementChild?.getAttribute('data-active-tab')).toBe(originalId);
    expect(host.firstElementChild?.getAttribute('data-repo')).toBe('/repo/selected');
    expect(h.load).not.toHaveBeenCalledWith('thoughts-older-chat');
    expect(host.querySelector('[data-terminal="terminal-a"]')?.textContent).toBe('cortex-dash-terminal-a');
    expect(host.querySelector('[data-terminal="terminal-b"]')?.textContent).toBe('cortex-dash-terminal-b');
    expect(saved.get('tile-root')?.tabs.find((tab) => tab.id === originalId)?.freshSpawn).toBe(true);
    const reloadedPages = JSON.parse(localStorage.getItem('o8:dashboard-page-layouts:v1') ?? '{}');
    expect(collectLeafNodes(JSON.parse(reloadedPages[originalId!]).root)).toHaveLength(3);
  } finally {
    await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); bootRepo = '/repo/original';
  }
});
