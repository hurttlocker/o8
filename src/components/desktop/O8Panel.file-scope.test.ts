// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { O8Panel } from './O8Panel';

// Keep the real panel's selection and tab routing, with unrelated tools inert.
vi.mock('./O8ActivityPane', () => ({ O8ActivityPane: () => null }));
vi.mock('./O8HandoffsPane', () => ({ O8HandoffsPane: () => null }));
vi.mock('./O8ResourcesPane', () => ({ O8ResourcesPane: () => null }));
vi.mock('./O8BrowserPane', () => ({ O8BrowserPane: () => null }));
vi.mock('./O8InboxPane', () => ({ O8InboxPane: () => null }));
vi.mock('./o8-panel/O8ThreadsPane', () => ({ O8ThreadsPane: () => null }));
vi.mock('./o8-panel/O8SpecPane', () => ({ O8SpecPane: () => null }));
vi.mock('./o8-panel/workspace-rail/O8ScratchChat', () => ({ O8ScratchChat: () => null }));
vi.mock('./comparison/ComparisonMatrix', () => ({ ComparisonMatrix: () => null }));
const reviewLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('./review/ReviewPanel', () => ({ ReviewPanel: function ReviewMemory() {
  const [remembered, setRemembered] = useState(false);
  useEffect(() => { reviewLifecycle.mounts++; return () => { reviewLifecycle.unmounts++; }; }, []);
  return createElement('button', { 'data-review-memory': true, onClick: () => setRemembered(true) }, remembered ? 'Review stored' : 'Remember review');
} }));
vi.mock('./o8-panel/O8RepoSelector', () => ({ O8RepoSelector: () => null }));
vi.mock('./o8-panel/TargetsPanel', () => ({ TargetsPanel: () => null }));
vi.mock('./o8-panel/ProjectChangesOverview', () => ({ ProjectChangesOverview: () => null }));
vi.mock('./o8-panel/WorkspaceBrowserPreview', () => ({ WorkspaceBrowserPreview: () => null }));
vi.mock('./ContextualPanel', () => ({ ContextualPanel: () => null }));
vi.mock('./o8-panel/workspace-rail/AllFilesTree', () => ({ AllFilesTree: ({ repoPath, onSelectFile }: { repoPath: string; onSelectFile: (path: string) => void }) => createElement('button', { 'data-tree-repo': repoPath, onClick: () => onSelectFile('src/file.ts') }, 'Select file') }));
vi.mock('./o8-panel/workspace-rail/FileViewer', () => ({ FileViewer: ({ repoPath, selectedFile }: { repoPath: string; selectedFile: string | null }) => createElement('output', { 'data-repo': repoPath }, selectedFile ?? 'No selection') }));

let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); reviewLifecycle.mounts = 0; reviewLifecycle.unmounts = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('panel file scope', () => {
  it('leaves Activity unselected while a contextual pull request owns the header', async () => {
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'activity', prNumber: 5 })));
    expect(host.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('false');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'activity', prNumber: null })));
    expect(host.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  });
  it('keeps one tool instance and its state across splitting, hiding, and legacy navigation', async () => {
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'workspace' })));
    const memory = host.querySelector<HTMLButtonElement>('[data-review-memory]')!;
    await act(async () => memory.click());
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'files', secondaryTab: 'review', onSecondaryTabChange: vi.fn() })));
    expect(host.querySelectorAll('[data-review-memory]')).toHaveLength(1);
    expect(host.querySelector('[data-review-memory]')).toBe(memory);
    expect(memory.textContent).toBe('Review stored'); expect(reviewLifecycle).toEqual({ mounts: 1, unmounts: 0 });
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'review', active: false })));
    expect(memory.closest('[inert]')).not.toBeNull();
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'review' })));
    expect(host.querySelector('[data-review-memory]')).toBe(memory); expect(reviewLifecycle.unmounts).toBe(0);
  });
  it('retains a selection across tools, but never carries a local path into another repo', async () => {
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'files' })));
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Select file')!.click());
    expect(host.querySelector('output')?.textContent).toBe('src/file.ts');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'review' })));
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'files' })));
    expect(host.querySelector('output')?.textContent).toBe('src/file.ts');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/two', activeTab: 'files', selectedFile: null })));
    expect(host.querySelector('output')).toBeNull();
    expect(host.querySelector('[data-tree-repo]')?.getAttribute('data-tree-repo')).toBe('/workspace/two');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-tree-repo]')!.click());
    expect(host.querySelector('output')?.textContent).toBe('src/file.ts');
    expect(host.querySelector('output')?.getAttribute('data-repo')).toBe('/workspace/two');
  });

  it('scopes a review action file to the repository named by the action', async () => {
    const onRepoPathChange = vi.fn();
    const onActiveTabChange = vi.fn();
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'files', onRepoPathChange, onActiveTabChange })));
    await act(async () => window.dispatchEvent(new CustomEvent('o8:focus-review', { detail: { repoPath: '/workspace/two', file: 'src/review.ts' } })));
    expect(onRepoPathChange).toHaveBeenCalledWith('/workspace/two');
    expect(onActiveTabChange).toHaveBeenCalledWith('review');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/two', activeTab: 'files' })));
    expect(host.querySelector('output')?.textContent).toBe('src/review.ts');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/three', activeTab: 'files' })));
    expect(host.querySelector('output')).toBeNull();
    expect(host.querySelector('[data-tree-repo]')?.getAttribute('data-tree-repo')).toBe('/workspace/three');
  });
  it('opens review media in the right repository and clears the file selection when browsing a directory', async () => {
    const onRepoPathChange = vi.fn(); const onActiveTabChange = vi.fn(); const onSelectedFileChange = vi.fn();
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/one', activeTab: 'review', onRepoPathChange, onActiveTabChange, onSelectedFileChange })));
    await act(async () => window.dispatchEvent(new CustomEvent('o8:browse-review-file', { detail: { repoPath: '/workspace/two', path: 'public/clip.mp4' } })));
    expect(onRepoPathChange).toHaveBeenCalledWith('/workspace/two'); expect(onActiveTabChange).toHaveBeenCalledWith('files');
    await act(async () => root.render(createElement(O8Panel, { repoPath: '/workspace/two', activeTab: 'files', onSelectedFileChange })));
    expect(host.querySelector('output')?.textContent).toBe('public/clip.mp4');
    await act(async () => window.dispatchEvent(new CustomEvent('o8:browse-review-file', { detail: { repoPath: '/workspace/two', path: null } })));
    expect(onSelectedFileChange).toHaveBeenLastCalledWith(''); expect(host.querySelector('output')).toBeNull();
    expect(host.querySelector('[data-tree-repo]')?.closest('[hidden]')).toBeNull();
  });
});
