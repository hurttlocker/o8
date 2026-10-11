import { expect, it } from 'vitest';
import { buildTerminalTabHandle, type ImperativeHandleDeps } from './terminal-imperative-handle';
import type { TerminalTab } from './types';

it('exposes the selected inspector kind to workspace chrome without changing tab identity or repository', () => {
  const tabsRef = { current: [{ id: 'requests', kind: 'canvas', label: 'Pull requests', lastActivity: 1, repo: { localPath: '/workspace' }, canvasTab: { id: 'requests', kind: 'pull-requests', label: 'Pull requests', resourceId: '/workspace' } }, { id: 'chat', kind: 'orchestrator', label: 'Current chat', lastActivity: 2 }] as TerminalTab[] };
  const handle = buildTerminalTabHandle({ tabsRef, activeTabId: 'requests' } as unknown as ImperativeHandleDeps);
  const snapshot = handle.getTabsSnapshot();
  expect(snapshot.activeTabId).toBe('requests');
  expect(snapshot.tabs[0]).toMatchObject({ id: 'requests', kind: 'canvas', canvasKind: 'pull-requests', repoPath: '/workspace' });
  expect(snapshot.tabs[1].canvasKind).toBeUndefined();
  expect(tabsRef.current[0].repo?.localPath).toBe('/workspace');
});
