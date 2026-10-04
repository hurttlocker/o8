// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installThreadNavigator, acknowledgeThreadSelection, readThreadSelection, threadPanelAvailability } from './thread-navigation';

const target = { workspaceId: 'workspace', repoPath: '/repo', taskId: 'task' };
afterEach(() => { vi.unstubAllGlobals(); });
describe('scoped thread navigation entry', () => {
  it('waits for the mounted task acknowledgement, not workspace activation', async () => {
    const activate = vi.fn();
    const cleanup = installThreadNavigator({
      resolve: () => ({ projectId: 'project', activate, isActive: () => true }),
      readTasks: async () => [{ id: 'task', repoPath: '/repo', project: { id: 'project' } }],
    });
    try {
      const result = window.__o8NavigateThread!(target);
      await Promise.resolve(); await Promise.resolve();
      expect(activate).toHaveBeenCalledOnce();
      expect(readThreadSelection()).toMatchObject(target);
      expect(acknowledgeThreadSelection({ ...target, taskId: 'other' })).toBe(false);
      expect(acknowledgeThreadSelection(target)).toBe(true);
      await expect(result).resolves.toMatchObject({ ok: true, status: 'mounted', ...target });
    } finally { cleanup(); }
  });
  it('refuses an out-of-scope persisted task before any selection changes', async () => {
    const activate = vi.fn();
    const cleanup = installThreadNavigator({
      resolve: () => ({ projectId: 'project', activate, isActive: () => true }),
      readTasks: async () => [{ id: 'task', repoPath: '/other', project: { id: 'project' } }],
    });
    try {
      await expect(window.__o8NavigateThread!(target)).resolves.toMatchObject({ ok: false, reason: 'task_unavailable' });
      expect(activate).not.toHaveBeenCalled();
      expect(readThreadSelection()).toBeNull();
    } finally { cleanup(); }
  });
  it.each([
    { id: 'other', panelProjectId: 'other' },
    { id: 'project', panelProjectId: null },
    { id: 'project', panelProjectId: ' project ' },
    null,
  ])('refuses wrong or unavailable project mapping without changing selection: %j', async (project) => {
    const activate = vi.fn();
    const cleanup = installThreadNavigator({
      resolve: () => ({ projectId: 'project', activate, isActive: () => true }),
      readTasks: async () => [{ id: 'task', repoPath: '/repo', project }],
    });
    try {
      await expect(window.__o8NavigateThread!(target)).resolves.toMatchObject({ ok: false, reason: 'task_unavailable' });
      expect(activate).not.toHaveBeenCalled();
      expect(readThreadSelection()).toBeNull();
    } finally { cleanup(); }
  });
  it('refuses missing workspaces without reading or mutating tasks', async () => {
    const readTasks = vi.fn();
    const cleanup = installThreadNavigator({ resolve: () => null, readTasks });
    try {
      await expect(window.__o8NavigateThread!(target)).resolves.toMatchObject({ ok: false, reason: 'workspace_unavailable' });
      expect(readTasks).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it.each([false, true])('refuses a collapsed panel before mutation, including narrowing during the read: %s', async (duringRead) => {
    let width = duringRead ? 1600 : 800;
    const activate = vi.fn();
    const readTasks = vi.fn(async () => {
      width = 800;
      return [{ id: 'task', repoPath: '/repo', project: { id: 'project' } }];
    });
    const cleanup = installThreadNavigator({
      availability: () => threadPanelAvailability(width, 1180),
      resolve: () => ({ projectId: 'project', activate, isActive: () => true }),
      readTasks,
    });
    try {
      await expect(window.__o8NavigateThread!(target)).resolves.toMatchObject({
        ok: false, reason: 'panel_viewport_unavailable', viewportWidth: 800, minimumWidth: 1180,
        recovery: { tool: 'o8_view_manage_window', operation: 'maximize' },
      });
      expect(readTasks).toHaveBeenCalledTimes(duringRead ? 1 : 0);
      expect(activate).not.toHaveBeenCalled();
      expect(readThreadSelection()).toBeNull();
    } finally { cleanup(); }
  });

});
