export const WORKSPACE_TAB_DRAG_TYPE = 'application/x-o8-workspace-tab';

export type WorkspaceTabDragKind = 'chat' | 'terminal';
export type WorkspaceTabDropZone = 'center' | 'left' | 'right' | 'above' | 'below';

export function workspaceTabDropZone(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number,
  clientY: number,
): WorkspaceTabDropZone {
  const x = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
  const y = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1)));
  const edges = [
    { zone: 'left' as const, distance: x },
    { zone: 'right' as const, distance: 1 - x },
    { zone: 'above' as const, distance: y },
    { zone: 'below' as const, distance: 1 - y },
  ];
  const nearest = edges.reduce((best, edge) => edge.distance < best.distance ? edge : best);
  return nearest.distance < 0.28 ? nearest.zone : 'center';
}
