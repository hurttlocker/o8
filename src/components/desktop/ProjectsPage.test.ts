/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsPage } from './ProjectsPage';

const projects = ['First', 'Second'].map((name) => ({
  id: name.toLowerCase(), name, slug: name.toLowerCase(), description: null,
  mainRepoId: null, createdAt: 1, updatedAt: 1, repos: [],
}));

afterEach(() => vi.unstubAllGlobals());

it.each(['first', 'repo:unassigned', 'legacy-project'])('opens a saved project or falls back to the library for %s', async (initialProjectId) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url === '/api/projects' ? { projects } : { repos: [], locks: [], fingerprints: [], context: null },
  })));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(ProjectsPage, { initialProjectId, onClose: vi.fn() })));
    const allProjects = [...container.querySelectorAll('button')].find((button) => button.textContent === 'All projects');
    if (initialProjectId === 'first') {
      expect(allProjects).toBeDefined();
      expect(container.querySelector('[aria-label="Saved projects"]')).toBeNull();
      expect(container.textContent).toContain('First');
      await act(async () => allProjects!.click());
    } else {
      expect(allProjects).toBeUndefined();
    }
    const library = container.querySelector('[aria-label="Saved projects"]');
    expect(library?.textContent).toContain('First');
    expect(library?.textContent).toContain('Second');
  } finally {
    act(() => root.unmount());
  }
});
