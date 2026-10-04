import type { ProjectContext } from '@/lib/projects/context';
import type { ProjectRecord } from '@/lib/repos/projects';

/** Map only the unique identity already resolved by ProjectContext, never repo overlap. */
export function taskPanelProjectId(context: ProjectContext, projects: ProjectRecord[]): string | null {
  const exact = projects.filter((project) => project.id === context.id);
  const candidates = exact.length ? exact : projects.filter((project) => (
    project.name.toLowerCase() === context.name.toLowerCase()
      && project.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === context.slug
  ));
  if (candidates.length !== 1 || candidates[0].id !== context.panelProjectId) return null;
  return context.panelProjectId.trim() === context.panelProjectId && context.panelProjectId ? context.panelProjectId : null;
}
