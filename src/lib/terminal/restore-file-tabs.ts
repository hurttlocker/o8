import path from 'node:path';
import type { PersistedTab, PersistedTabState } from './tab-state';

/** Upgrade legacy absolute file tabs using only known repository roots.
 * This restores navigation context; the file route still validates every read.
 * Unmatched paths remain unchanged; existing removed-repository filtering still applies.
 */
export function restoreFileTabContext(data: unknown, repoRoots: ReadonlySet<string>): unknown {
  if (!data || typeof data !== 'object') return data;
  const state = data as Partial<PersistedTabState>;
  if (!Array.isArray(state.tabs)) return data;
  const roots = [...repoRoots].sort((left, right) => right.length - left.length);
  let changed = false;
  const tabs = state.tabs.map((tab: PersistedTab) => {
    const file = tab?.canvasTab;
    if (tab?.kind !== 'canvas' || file?.kind !== 'file'
      || typeof file.resourceId !== 'string' || !path.isAbsolute(file.resourceId)) return tab;
    const workspace = roots.find((root) => {
      const relative = path.relative(root, file.resourceId);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
    if (!workspace) return tab;
    const filePath = path.relative(workspace, file.resourceId).split(path.sep).join('/');
    changed = true;
    return {
      ...tab,
      repoPath: workspace,
      repoName: tab.repoPath === workspace ? tab.repoName : path.basename(workspace),
      canvasTab: {
        ...file,
        id: `file:${filePath}:${workspace}`,
        resourceId: filePath,
        meta: { ...file.meta, workspace },
      },
    };
  });
  return changed ? { ...state, tabs } : data;
}
