// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ browser: false, files: false, review: false }));

vi.mock('../O8BrowserPane', () => {
  loaded.browser = true;
  return { O8BrowserPane: () => createElement('div', { 'data-panel': 'browser' }) };
});
vi.mock('../o8-panel/workspace-rail/WorkspaceFilesPane', () => {
  loaded.files = true;
  return { WorkspaceFilesPane: ({ selectedFile }: { selectedFile: string | null }) =>
    createElement('div', { 'data-panel': 'files' }, selectedFile) };
});
vi.mock('../review/ReviewPanel', () => {
  loaded.review = true;
  return { ReviewPanel: ({ repoPath }: { repoPath: string }) =>
    createElement('div', { 'data-panel': 'review' }, repoPath) };
});

it('loads utility implementations only when their real bottom-panel entry point is selected', async () => {
  const { BOTTOM_PANEL_SURFACES, BottomUtilitySurface } = await import('./surfaces');
  expect(BOTTOM_PANEL_SURFACES.map(surface => surface.id)).toContain('review');
  expect(loaded, 'closed utility panels must stay outside the dashboard bootstrap graph').toEqual({
    browser: false, files: false, review: false,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = { tabId: 'saved-utility', active: true, repoPath: '/tmp/fixture-repo', repoLabel: 'Fixture',
    registeredRepos: [], previews: [], selectedFile: 'fixture.txt', dirtyFiles: new Set<string>(), onSelectFile: vi.fn() };
  try {
    for (const kind of ['files', 'browser', 'review'] as const) {
      await act(async () => {
        root.render(createElement(BottomUtilitySurface, { ...props, kind }));
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      await vi.waitFor(() => expect(container.querySelector(`[data-panel="${kind}"]`)).not.toBeNull());
      expect(loaded[kind]).toBe(true);
    }
    expect(container.textContent).toContain(props.repoPath);
  } finally {
    await act(async () => root.unmount());
  }
});
