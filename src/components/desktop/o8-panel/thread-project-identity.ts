interface ThreadProjectIdentity {
  id: string;
  panelProjectId?: string | null;
}

/** An explicit unavailable mapping must not fall back to a different identity. */
export function threadProjectMatches(project: ThreadProjectIdentity | null | undefined, panelProjectId: string | null): boolean {
  if (!panelProjectId) return true;
  if (!project) return false;
  if (!Object.prototype.hasOwnProperty.call(project, 'panelProjectId')) return project.id === panelProjectId;
  return typeof project.panelProjectId === 'string'
    && project.panelProjectId.length > 0
    && project.panelProjectId.trim() === project.panelProjectId
    && project.panelProjectId === panelProjectId;
}
