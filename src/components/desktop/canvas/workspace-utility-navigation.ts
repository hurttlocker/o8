import type { CanvasTab } from '../Canvas';

export type WorkspaceUtilityKind = 'automations' | 'plugins' | 'customize';

export function workspaceUtilityTab(kind: WorkspaceUtilityKind, projectId?: string | null): CanvasTab {
  const scope = projectId ?? 'personal';
  return {
    id: kind === 'automations' ? 'automations' : `${kind}:${scope}`,
    kind,
    label: kind === 'automations' ? 'Automations' : kind === 'plugins' ? 'Plugins' : 'Customize',
    resourceId: kind,
    meta: kind === 'automations' ? undefined : { projectId: scope },
  };
}

export function isWorkspaceUtilityKind(kind?: string): kind is WorkspaceUtilityKind {
  return kind === 'automations' || kind === 'plugins' || kind === 'customize';
}
