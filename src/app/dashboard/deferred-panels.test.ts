// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const imports = vi.hoisted(() => ({ projects: 0, focus: 0 }));
vi.mock('@/components/desktop/ProjectsPage', () => {
  imports.projects++;
  return { ProjectsPage: () => null };
});
vi.mock('@/components/desktop/repo-focus/LeftPanelProjectFocus', () => {
  imports.focus++;
  return { LeftPanelProjectFocus: () => null };
});

it('imports the real dashboard without evaluating closed Projects or project-focus panels', async () => {
  const { default: DashboardPage } = await import('./page');
  expect(typeof DashboardPage).toBe('function');
  expect(imports, 'closed navigation panels must load when selected').toEqual({ projects: 0, focus: 0 });
});
