// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, createElement, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '@/components/desktop/CommandPalette';
import { Canvas, type CanvasTab } from '@/components/desktop/Canvas';
import { FileViewer } from '@/components/desktop/FileViewer';
import { usePaletteFileSelection } from '@/app/dashboard/hooks/usePaletteFileSelection';
import { useTileLayout } from '@/app/dashboard/hooks/useTileLayout';
import { createDefaultTileLayout, getFirstLeaf } from '@/lib/tiles/operations';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { TerminalTab, TerminalTabHandle } from '@/components/desktop/workspace-terminal/types';
import { CanvasCommandPalette } from '@/app/preview/canvas-glass/canvas-command-palette';
import type { CanvasCommands } from '@/app/preview/canvas-glass/canvas-commands';
import { GET as search } from '@/app/api/panel/search/route';
import { listReposFresh } from '@/lib/repos/registry';
import { GET as readFile } from '@/app/api/panel/file-content/route';
import { GET as readState, POST as writeState } from '@/app/api/panel/terminal-state/route';
import { computeInspectorTab } from '@/components/desktop/workspace-terminal/terminal-session-ops';
import { buildPersistedState } from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import { computeRestoredTabs } from '@/components/desktop/workspace-terminal/terminal-restore';
import { loadTabState, saveTabState, type PersistedTabState } from '@/lib/terminal/tab-state';

// Only file search participates; unrelated providers must not contact services.
vi.mock('@/lib/search/agents', () => ({ searchAgents: async () => [] }));
vi.mock('@/lib/search/approvals', () => ({ searchApprovals: async () => [] }));
vi.mock('@/lib/search/conversations', () => ({ searchConversations: async () => [] }));
vi.mock('@/lib/search/directives', () => ({ searchDirectives: () => [] }));
vi.mock('@/lib/search/inbox', () => ({ searchInbox: async () => [] }));
vi.mock('@/lib/search/issues', () => ({ searchIssues: async () => [], browseIssues: async () => [] }));
vi.mock('@/lib/search/transcripts', () => ({ searchTranscripts: async () => [] }));
vi.mock('@/lib/search/recall', () => ({ searchRecall: async () => ({ results: [] }) }));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
  }) => {
    const domProps = { ...props };
    delete domProps.initial; delete domProps.animate; delete domProps.exit; delete domProps.transition;
    return createElement('div', domProps, children);
  } },
}));
vi.mock('@/components/desktop/canvas/index', () => ({
  CanvasEmpty: () => null, CIViewer: () => null, DeployViewer: () => null,
  DiffViewer: () => null, GitLogViewer: () => null, ImagePreview: () => null,
  MermaidViewer: () => null, PortPreview: () => null, ReadmeViewer: () => null,
  TranscriptViewer: () => null,
}));
// Keep the real Rich editor. Only the unrelated Monaco loader/native integration
// is replaced; these assertions do not claim native Source rendering coverage.
vi.mock('next/dynamic', () => ({ default: () => (props: { value: string }) => (
  createElement('textarea', { 'data-testid': 'source-editor', value: props.value, readOnly: true })
) }));
vi.mock('@monaco-editor/react', () => ({ loader: { init: vi.fn() } }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ themeId: 'light-solid' }) }));
vi.mock('@/lib/hooks/use-tauri-file-drop', () => ({ useTauriFileDrop: () => ({ dragOver: false }) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
let fixture: string;
let repos: Array<{ id: string; name: string; localPath: string }>;
let container: HTMLDivElement;
let root: Root;
let opened: CanvasTab[];
let openedWorkspaceTabs: TerminalTab[];
let requestedScopes: Array<string | null>;
let registeredRepos: RepoRegistryEntry[];
let requests: URL[];

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await settle();
  expect(check()).toBe(true);
}
function button(label: string) {
  const result = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}
function SearchHarness({ workspace = null }: { workspace?: string | null }) {
  const [tabs, setTabs] = useState<CanvasTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [layout, setLayout] = useState(createDefaultTileLayout);
  const [activeTileId, setActiveTileId] = useState<string | null>('tile-root');
  const contextualPanelHandlesRef = useRef(new Map());
  const workspaceTerminalHandlesRef = useRef(new Map<string, TerminalTabHandle>());
  const { openCanvasTab } = useTileLayout({
    activeTileId, activeWorkspaceChatSessionKey: undefined, contextualPanelHandlesRef,
    findInsertionTarget: () => getFirstLeaf(layout.root), findWorkspaceTarget: () => null,
    globalRepoEntries: registeredRepos, globalRepoEntry: null, refreshRestoredRepoState: async () => true,
    setActiveTileId, setTileLayout: setLayout, tileLayout: layout,
    workspaceChatTargetKeyByRepoPath: {}, workspaceChatTargets: [], workspaceSidePanelRepoPath: null,
    workspaceTerminalHandlesRef, workspaceTerminalPreferredRepo: null,
    waitForWorkspaceTerminalTarget: async (options) => {
      requestedScopes.push(options?.repoPath ?? null);
      // The native terminal handle is the only adapter stub: execute the real
      // tab constructor with the repository selected by useTileLayout.
      const handle: Pick<TerminalTabHandle, 'openInspectorTab'> = {
        openInspectorTab: (tab, tabOptions) => {
          const terminalTab = computeInspectorTab(tab, [], tabOptions).newTab!;
          openedWorkspaceTabs.push(terminalTab);
          opened.push(tab);
          setTabs((current) => current.some((entry) => entry.id === tab.id) ? current : [...current, tab]);
          setActive(tab.id);
          return terminalTab.id;
        },
      };
      return { tileId: 'tile-root', handle: handle as TerminalTabHandle };
    },
  });
  const select = usePaletteFileSelection(workspace, openCanvasTab);
  return createElement('div', null,
    createElement(CommandPalette, {
      open, workspace, onClose: () => setOpen(false), onSelectFile: select,
      onSelectIssue: () => {}, onSelectAgent: () => {},
    }),
    createElement(Canvas, { tabs, activeTabId: active, onSelectTab: setActive, onCloseTab: () => {}, embedded: true }),
  );
}
async function searchAndOpen(repoName: string, query = 'readme', workspace: string | null = null) {
  await act(async () => { root.render(createElement(SearchHarness, { key: `${repoName}:${query}`, workspace })); });
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => Array.from(container.querySelectorAll('[data-palette-index]')).some((node) => (
    node.textContent?.includes(repoName) || (workspace && node.textContent?.includes(query.split('/').pop()!))
  )));
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-palette-index]')).find((node) => (
    node.textContent?.includes(repoName) || (workspace && node.textContent?.includes(query.split('/').pop()!))
  ))!;
  await act(async () => { row.click(); });
  await until(() => requests.some((url) => url.pathname === '/api/panel/file-content'));
}
async function persistAndRestore(tabs: CanvasTab[]) {
  const terminalTabs = tabs.map((tab) => openedWorkspaceTabs.find((entry) => entry.canvasTab === tab)
    ?? computeInspectorTab(tab, [], { repo: repos.find((repo) => repo.localPath === tab.meta?.workspace) }).newTab!);
  await saveTabState(buildPersistedState(terminalTabs, terminalTabs[0].id), 'search-context');
  const disk = JSON.parse(readFileSync(path.join(dataDir, 'terminal-states', 'search-context.json'), 'utf8')) as PersistedTabState;
  expect(disk.tabs.map((tab) => tab.canvasTab?.meta?.workspace)).toEqual(tabs.map((tab) => tab.meta?.workspace));
  expect(disk.tabs.map((tab) => tab.repoPath)).toEqual(tabs.map((tab) => tab.meta?.workspace));
  const saved = await loadTabState('search-context');
  const restored = await computeRestoredTabs(saved!, {
    preferredRepo: null, defaultTab: 'terminal', createDefaultChatTab: () => { throw new Error('Unexpected default chat'); },
  });
  return restored!.tabs;
}

beforeEach(async () => {
  fixture = mkdtempSync(path.join(tmpdir(), 'o8-search-context-'));
  repos = ['alpha repo', 'beta repo'].map((name, i) => ({ id: `repo-${i}`, name, localPath: path.join(fixture, name) }));
  for (const repo of repos) {
    mkdirSync(path.join(repo.localPath, 'docs with spaces'), { recursive: true });
    writeFileSync(path.join(repo.localPath, 'README.md'), `# ${repo.name}\n\nCorrect repository content.\n`);
    writeFileSync(path.join(repo.localPath, 'docs with spaces', 'nested note.md'), `# Nested ${repo.name}\n`);
    writeFileSync(path.join(repo.localPath, 'docs with spaces', 'settings file.json'), JSON.stringify({ repo: repo.name }));
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos }));
  registeredRepos = await listReposFresh();
  localStorage.clear();
  opened = []; openedWorkspaceTabs = []; requestedScopes = []; requests = [];
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url);
    if (url.pathname === '/api/panel/ide-surface') return Response.json({ ok: true });
    if (url.pathname === '/api/panel/search') return search(new Request(url));
    if (url.pathname === '/api/panel/file-content') return readFile(new Request(url));
    if (url.pathname === '/api/panel/file-diff') return Response.json({ diff: '', hasDiff: false });
    if (url.pathname === '/api/panel/terminal-state') return init?.method === 'POST'
      ? writeState(new Request(url, init)) : readState(new Request(url));
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); container.remove();
  vi.unstubAllGlobals();
  rmSync(fixture, { recursive: true, force: true });
  rmSync(path.join(dataDir, 'terminal-states'), { recursive: true, force: true });
});

describe('search activation through the real viewer, file route and saved tabs', () => {
  it('opens the selected same-named file globally and restores its repository context', async () => {
    await searchAndOpen('beta repo');
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    expect(opened[0]).toMatchObject({ resourceId: 'README.md', meta: { workspace: repos[1].localPath } });
    expect(container.textContent).toContain('beta repo');
    await act(async () => { button('Source').click(); });
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="source-editor"]')?.value).toContain('# beta repo');
    await act(async () => { button('Rich').click(); });
    expect(container.textContent).toContain('Correct repository content.');
    const restored = await persistAndRestore(opened);
    await act(async () => { root.render(createElement(Canvas, {
      tabs: restored.map((tab) => tab.canvasTab!), activeTabId: restored[0].canvasTab!.id,
      onSelectTab: () => {}, onCloseTab: () => {}, embedded: true,
    })); });
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    expect(requests.filter((url) => url.pathname === '/api/panel/file-content').every((url) => (
      url.searchParams.get('path') === 'README.md' && url.searchParams.get('workspace') === repos[1].localPath
    ))).toBe(true);
  });

  it.each([
    ['nested note.md', true], ['settings file.json', true],
    ['nested note.md', false], ['settings file.json', false],
  ])('opens nested space-containing %s (scoped=%s)', async (filename, scoped) => {
    await searchAndOpen('alpha repo', filename as string, scoped ? repos[0].localPath : null);
    await until(() => !container.textContent?.includes('Loading file'));
    expect(opened[0]).toMatchObject({ resourceId: `docs with spaces/${filename}`, meta: { workspace: repos[0].localPath } });
    expect(container.textContent).not.toContain('Could not load file content');
    expect(requests.find((url) => url.pathname === '/api/panel/file-content')?.searchParams.get('path')).toBe(`docs with spaces/${filename}`);
  });

  it('routes a nested registered repository through the actual workspace handle and persists that exact scope', async () => {
    const nested = { id: 'nested', name: 'nested repo', localPath: path.join(repos[0].localPath, 'nested repo') };
    mkdirSync(nested.localPath);
    writeFileSync(path.join(nested.localPath, 'README.md'), '# Nested correct repository content.');
    repos.push(nested);
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos }));
    registeredRepos = await listReposFresh();
    // Keep the parent first to expose first-containing-root selection.
    registeredRepos.sort((left, right) => left.localPath.length - right.localPath.length);
    await searchAndOpen('nested repo', 'README', nested.localPath);
    await until(() => container.textContent?.includes('Nested correct repository content.') === true);
    expect(requestedScopes).toEqual([nested.localPath]);
    expect(openedWorkspaceTabs[0].repo?.localPath).toBe(nested.localPath);
    const restored = await persistAndRestore(opened);
    expect(restored[0].repo?.localPath).toBe(nested.localPath);
    expect(restored[0].canvasTab?.meta?.workspace).toBe(nested.localPath);
  });

  it('converts global and shared-recent results for the absolute-path canvas file-card consumer', async () => {
    const spawnFile = vi.fn();
    const commands = Object.fromEntries([
      'spawnTerminal', 'spawnTree', 'spawnImage', 'spawnVideo', 'spawnBrowser', 'spawnChat',
      'spawnDiff', 'spawnSpec', 'spawnBrain', 'spawnMarkdown', 'spawnAgent', 'openSearch',
      'closeActiveCard', 'zoomIn', 'zoomToFit', 'zoomOut',
    ].map((name) => [name, vi.fn()])) as unknown as CanvasCommands;
    commands.spawnFile = spawnFile;
    await act(async () => { root.render(createElement(CanvasCommandPalette, { commands })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); });
    await until(() => container.querySelector('input') !== null);
    const input = container.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'readme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => Array.from(container.querySelectorAll('[data-palette-index]')).some((node) => node.textContent?.includes('beta repo')));
    const row = Array.from(container.querySelectorAll<HTMLElement>('[data-palette-index]')).find((node) => node.textContent?.includes('beta repo'))!;
    await act(async () => { row.click(); });
    expect(spawnFile).toHaveBeenLastCalledWith(path.join(repos[1].localPath, 'README.md'));
    await act(async () => { root.render(createElement(CanvasCommandPalette, { commands, repo: repos[0].localPath })); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })); });
    await until(() => container.querySelector('[data-palette-index]') !== null);
    const recent = Array.from(container.querySelectorAll<HTMLElement>('[data-palette-index]')).find((node) => node.textContent?.includes('README.md'))!;
    await act(async () => { recent.click(); });
    expect(spawnFile).toHaveBeenCalledTimes(2);
    expect(spawnFile).toHaveBeenLastCalledWith(path.join(repos[1].localPath, 'README.md'));
  });

  it('keeps same-named tabs distinct across switching, persistence, and an unchanged reopen', async () => {
    await searchAndOpen('alpha repo');
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    await searchAndOpen('beta repo');
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    expect(new Set(opened.map((tab) => tab.id)).size).toBe(2);
    const restored = await persistAndRestore(opened);
    const tabs = restored.map((tab) => tab.canvasTab!);
    for (const index of [0, 1, 0]) {
      await act(async () => { root.render(createElement(Canvas, {
        tabs, activeTabId: tabs[index].id, onSelectTab: () => {}, onCloseTab: () => {}, embedded: true,
      })); });
      await until(() => container.textContent?.includes('Correct repository content.') === true);
      expect(container.querySelector('.ProseMirror')?.textContent).toContain(repos[index].name);
    }
    await act(async () => { root.render(null); });
    await searchAndOpen('alpha repo');
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    expect(opened[2]).toEqual(opened[0]);
  });

  it('reopens a recent file in its original repository after the active workspace changes', async () => {
    await searchAndOpen('beta repo');
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    await act(async () => { root.render(null); });
    await act(async () => { root.render(createElement(SearchHarness, { workspace: repos[0].localPath })); });
    const recent = Array.from(container.querySelectorAll<HTMLElement>('[data-palette-index]'))
      .find((node) => node.textContent?.includes('README.md'));
    expect(recent).toBeDefined();
    await act(async () => { recent!.click(); });
    await until(() => container.textContent?.includes('Correct repository content.') === true);
    expect(opened[1]).toEqual(opened[0]);
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('beta repo');
  });

  it('uses the longest registered root for legacy nested repositories and preserves unmatched tabs', async () => {
    const nested = { id: 'nested', name: 'nested', localPath: path.join(repos[0].localPath, 'nested') };
    mkdirSync(nested.localPath);
    writeFileSync(path.join(nested.localPath, 'README.md'), '# Nested repository');
    repos.push(nested);
    writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos }));
    registeredRepos = await listReposFresh();
    const absolutePaths = [path.join(nested.localPath, 'README.md'), path.join(fixture, 'unregistered', 'README.md')];
    const tabs: CanvasTab[] = absolutePaths.map((file, index) => ({
      id: `legacy-${index}`, kind: 'file', label: 'README.md', resourceId: file,
    }));
    const restored = await persistAndRestore(tabs);
    expect(restored).toHaveLength(2);
    expect(restored[0].canvasTab).toMatchObject({ resourceId: 'README.md', meta: { workspace: nested.localPath } });
    expect(restored[1].canvasTab).toEqual(tabs[1]);
    await saveTabState(buildPersistedState(restored, restored[0].id), 'search-context');
    const savedAgain = await loadTabState('search-context');
    expect(savedAgain!.tabs[0].canvasTab).toEqual(restored[0].canvasTab);
  });

  it('retains the existing pruning contract for a legacy tab bound to a removed repository', async () => {
    const removedRoot = path.join(fixture, 'removed repository');
    const legacy: CanvasTab = {
      id: 'removed-file', kind: 'file', label: 'README.md', resourceId: path.join(removedRoot, 'README.md'),
      meta: { workspace: removedRoot },
    };
    const terminal = computeInspectorTab(legacy, [], { repo: { name: 'removed', localPath: removedRoot } }).newTab!;
    await saveTabState(buildPersistedState([terminal], terminal.id), 'removed-context');
    expect(await loadTabState('removed-context')).toBeNull();
  });

  it('restores old absolute-path tabs using the registered containing root, not an unrelated saved workspace', async () => {
    const legacy: CanvasTab = {
      id: 'legacy-file', kind: 'file', label: 'README.md', resourceId: path.join(repos[1].localPath, 'README.md'),
      meta: { workspace: repos[0].localPath, line: '2' },
    };
    const restored = await persistAndRestore([legacy]);
    expect(restored[0].canvasTab).toMatchObject({ resourceId: 'README.md', meta: { workspace: repos[1].localPath, line: '2' } });
    expect(restored[0].repo?.localPath).toBe(repos[1].localPath);
    await act(async () => { root.render(createElement(FileViewer, {
      filePath: restored[0].canvasTab!.resourceId, workspace: restored[0].canvasTab!.meta?.workspace,
    })); });
    await until(() => container.textContent?.includes('Correct repository content.') === true);
  });

  it('shows a read error without empty-file metadata and retries the same target', async () => {
    await act(async () => { root.render(createElement(FileViewer, { filePath: 'missing.md', workspace: repos[0].localPath })); });
    await until(() => !container.textContent?.includes('Loading file'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('File not found.');
    expect(container.textContent).not.toContain('1 lines');
    expect(container.textContent).not.toContain('0 B');
    writeFileSync(path.join(repos[0].localPath, 'missing.md'), '# Recovered file\n');
    await act(async () => { button('Retry').click(); });
    await until(() => container.textContent?.includes('Recovered file') === true);
  });

  it('keeps an actually empty file readable, with accurate metadata', async () => {
    writeFileSync(path.join(repos[0].localPath, 'empty.md'), '');
    await act(async () => { root.render(createElement(FileViewer, { filePath: 'empty.md', workspace: repos[0].localPath })); });
    await until(() => container.textContent?.includes('0 B') === true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('.ProseMirror')).not.toBeNull();
  });

  it('preserves file-route rejection of traversal, absolute, unregistered and escaping symlink paths', async () => {
    writeFileSync(path.join(fixture, 'outside.md'), 'outside');
    symlinkSync(fixture, path.join(repos[0].localPath, 'outside'), 'junction');
    for (const [file, workspace, status] of [
      ['../outside.md', repos[0].localPath, 403],
      [path.join(repos[0].localPath, 'README.md'), repos[0].localPath, 403],
      ['outside/outside.md', repos[0].localPath, 403],
      ['outside.md', fixture, 400],
    ] as const) {
      const params = new URLSearchParams({ path: file, workspace });
      const response = await readFile(new Request(`http://localhost/api/panel/file-content?${params}`));
      expect(response.status).toBe(status);
      expect((await response.json()).content).toBeNull();
    }
  });
});
