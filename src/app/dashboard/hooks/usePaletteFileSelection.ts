import { useCallback } from 'react';
import type { CanvasTab } from '@/components/desktop/Canvas';

export function usePaletteFileSelection(
  activeWorkspace: string | null | undefined,
  openCanvasTab: (tab: CanvasTab) => void,
) {
  return useCallback((filePath: string, line?: number, workspace = activeWorkspace) => {
    openCanvasTab({
      id: `file:${filePath}${workspace ? `:${workspace}` : ''}`,
      kind: 'file',
      label: filePath.split('/').pop() ?? filePath,
      resourceId: filePath,
      meta: {
        ...(workspace ? { workspace } : {}),
        ...(line ? { line: String(line) } : {}),
      },
    });
  }, [activeWorkspace, openCanvasTab]);
}
