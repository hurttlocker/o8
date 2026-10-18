// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { ProjectsSwitcher } from './ProjectsSwitcher';

vi.mock('framer-motion', () => ({ useReducedMotion: () => true, motion: { div: 'div' } }));
vi.mock('../FloatingSurface', () => ({ FloatingSurface: ({ children }: HTMLAttributes<HTMLDivElement>) => createElement('div', null, children) }));
vi.mock('./ProjectGroupDialog', () => ({ ProjectGroupDialog: () => null }));
vi.mock('./ConnectRepositoryDialog', () => ({ ConnectRepositoryDialog: () => null }));

const repos: RepoRegistryEntry[] = ['web', 'api', 'mobile', 'docs', 'tools', 'worker'].map((name) => ({
  id: name, name, localPath: `/preview/${name}`, remoteUrl: null, defaultBranch: 'main',
  addedAt: '2026-10-17T00:00:00.000Z', lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: {
    envMode: 'copy', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
    workspaceIsolationPreference: 'auto',
  },
}));
const props: ComponentProps<typeof ProjectsSwitcher> = {
  projects: [{ id: 'preview', name: 'Preview', repoPaths: repos.map((repo) => repo.localPath), createdAt: repos[0].addedAt }],
  activeProjectId: 'preview', selectedRepoPath: repos[0].localPath,
  registeredRepoByPath: new Map(repos.map((repo) => [repo.localPath, repo])),
  onProjectSelect: vi.fn(async () => true), onRepoSelect: vi.fn(), onManageProjects: vi.fn(), onAddRepo: vi.fn(),
};
let root: Root;
let host: HTMLDivElement;

let observers: ResizeObserverCallback[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); observers = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
  vi.mocked(props.onRepoSelect).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const row = () => host.querySelector<HTMLElement>('[aria-label="Project repositories"]')!;
const chips = () => Array.from(row().querySelectorAll<HTMLButtonElement>('[data-repository-chip]'));
function render(selectedRepoPath = props.selectedRepoPath, count = 6) {
  act(() => root.render(createElement(ProjectsSwitcher, { ...props, selectedRepoPath,
    projects: [{ ...props.projects[0], repoPaths: repos.slice(0, count).map(repo => repo.localPath) }] })));
}
function resize(width: number, nameWidth = 68) {
  Object.defineProperty(row(), 'clientWidth', { configurable: true, value: width });
  host.querySelectorAll<HTMLElement>('[data-repository-measure]').forEach(node => Object.defineProperty(node, 'offsetWidth', { configurable: true, value: nameWidth }));
  act(() => [...observers].forEach(callback => callback([], {} as ResizeObserver)));
}
describe('adaptive project repository navigation', () => {
  it('keeps the selected repo visible, puts remaining repos in a keyboard menu and selects the exact repo', () => {
    render(repos[5].localPath); resize(260);
    expect(chips()).toHaveLength(3); expect(chips()[0].textContent).toContain('worker');
    const more = row().querySelector<HTMLButtonElement>('[aria-label="3 more repositories"]')!;
    expect(more).not.toBeNull(); act(() => more.click());
    const choice = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Open docs repository"]')!;
    expect(choice).not.toBeNull(); act(() => choice.click());
    expect(props.onRepoSelect).toHaveBeenCalledExactlyOnceWith(props.projects[0], repos[3].localPath);
    expect(document.querySelector('[aria-label="More repositories"]')).toBeNull();
    render(repos[3].localPath); resize(120); expect(chips()).toHaveLength(1); expect(chips()[0].textContent).toContain('docs');
    resize(260); expect(chips()).toHaveLength(3);
  });
  it('shows every short name when three fit, and uses overflow when names or the sidebar need more room', () => {
    render(repos[0].localPath, 3); resize(260);
    expect(chips()).toHaveLength(3); expect(row().querySelector('[aria-haspopup="menu"]')).toBeNull();
    resize(260, 140); expect(chips()).toHaveLength(1); expect(row().querySelector('[aria-label="2 more repositories"]')).not.toBeNull();
    resize(400, 140); expect(chips()).toHaveLength(2);
    render(repos[0].localPath, 1); expect(host.querySelector('[aria-label="Project repositories"]')).toBeNull();
  });
});
