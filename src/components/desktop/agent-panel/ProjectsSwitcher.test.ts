// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { ProjectsSwitcher } from './ProjectsSwitcher';

vi.mock('framer-motion', () => ({ useReducedMotion: () => true, motion: { div: 'div' } }));
vi.mock('../thoughts/chat-panel/ComposerPopover', () => ({ ComposerPopover: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null }));
vi.mock('./ProjectGroupDialog', () => ({ ProjectGroupDialog: () => null }));
vi.mock('./ConnectRepositoryDialog', () => ({ ConnectRepositoryDialog: () => null }));

const repos: RepoRegistryEntry[] = ['web', 'api', 'mobile'].map((name) => ({
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function render(registeredRepoByPath = props.registeredRepoByPath) {
  act(() => root.render(createElement(ProjectsSwitcher, { ...props, registeredRepoByPath })));
}
function strip() {
  const element = host.querySelector<HTMLDivElement>('[aria-label="Project repositories"]')!;
  Object.defineProperties(element, { clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 600 } });
  return element;
}
function wheel(element: HTMLDivElement, init: WheelEventInit) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  element.querySelector('button')!.dispatchEvent(event);
  return event;
}

describe('project repository wheel navigation', () => {
  it('moves the rendered repository row in both directions when rolling a vertical wheel over a chip', () => {
    render(); const row = strip();
    expect(wheel(row, { deltaY: 120 }).defaultPrevented).toBe(true);
    expect(row.scrollLeft).toBe(120);
    expect(wheel(row, { deltaY: -40 }).defaultPrevented).toBe(true);
    expect(row.scrollLeft).toBe(80);
  });

  it('preserves horizontal trackpads, zoom, and scrolling at either boundary', () => {
    render(); const row = strip();
    expect(wheel(row, { deltaY: -120 }).defaultPrevented).toBe(false);
    expect(wheel(row, { deltaX: 80, deltaY: 20 }).defaultPrevented).toBe(false);
    expect(wheel(row, { deltaY: 80, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel(row, { deltaY: 80, metaKey: true }).defaultPrevented).toBe(false);
    expect(row.scrollLeft).toBe(0);
    wheel(row, { deltaY: 1000 });
    expect(row.scrollLeft).toBe(400);
    expect(wheel(row, { deltaY: 80 }).defaultPrevented).toBe(false);
  });

  it('binds when multiple repositories arrive and cleans up when the row disappears', () => {
    const singleRepo = new Map([[repos[0].localPath, repos[0]]]);
    render(singleRepo);
    expect(host.querySelector('[aria-label="Project repositories"]')).toBeNull();
    render(); const first = strip();
    wheel(first, { deltaY: 30 }); expect(first.scrollLeft).toBe(30);
    render(singleRepo);
    expect(wheel(first, { deltaY: 30 }).defaultPrevented).toBe(false);
    expect(first.scrollLeft).toBe(30);
    render(); const replacement = strip();
    wheel(replacement, { deltaY: 45 }); expect(replacement.scrollLeft).toBe(45);
  });
});
