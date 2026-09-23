import type { ProjectRecord } from '../repo-registry/useProjects';
import type { RepoRegistryEntry } from '../repo-registry/shared';
import type { RepoFocusRepo } from '../repo-focus/types';
import { dispatchFocusRepoWorkspaceTab } from '@/lib/desktop/events';
import { isVirtualRepoProjectId, virtualProjectRepoId } from '@/lib/repos/virtual-project-id';

function normalizeRepoRef(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function resolveRepoRef(
  value: string,
  registeredRepoById: Map<string, RepoRegistryEntry>,
): string {
  return normalizeRepoRef(registeredRepoById.get(value)?.localPath ?? value);
}

/**
 * The ledger can transiently contain both a real project membership and the
 * read-model's virtual single-repo fallback. Keep every real membership, but
 * suppress the fallback when its repository is already represented by one.
 * This changes only the navigation projection; it never mutates ledger data.
 */
export function visibleProjectNavigationItems(
  projects: ProjectRecord[],
  registeredRepos: RepoRegistryEntry[],
): ProjectRecord[] {
  const registeredRepoById = new Map(registeredRepos.map((repo) => [repo.id, repo]));
  const realProjectRepoPaths = new Set(
    projects
      .filter((project) => project.id !== 'default' && !isVirtualRepoProjectId(project.id))
      .flatMap((project) => project.repoPaths)
      .map((repoRef) => resolveRepoRef(repoRef, registeredRepoById))
      .filter(Boolean),
  );
  const hasProjectOutsideDefault = projects.some((project) => project.id !== 'default');
  const withoutLegacyDefault = hasProjectOutsideDefault
    ? projects.filter((project) => project.id !== 'default')
    : projects;

  return withoutLegacyDefault.filter((project) => {
    if (!isVirtualRepoProjectId(project.id)) return true;
    const virtualRepoId = virtualProjectRepoId(project.id);
    const candidateRefs = [
      ...project.repoPaths,
      ...(virtualRepoId ? [virtualRepoId] : []),
    ];
    return !candidateRefs.some((repoRef) => (
      realProjectRepoPaths.has(resolveRepoRef(repoRef, registeredRepoById))
    ));
  });
}

export function groupProjectNavigationItems(
  projects: ProjectRecord[],
  activeProjectId: string | null,
): { currentProject: ProjectRecord | null; otherProjects: ProjectRecord[] } {
  const currentProject = projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
  return {
    currentProject,
    otherProjects: currentProject
      ? projects.filter((project) => project.id !== currentProject.id)
      : [],
  };
}

export function selectWorkingRepository(
  repo: RepoFocusRepo,
  onSelectRepo?: (repoId: string) => void,
  focusWorkspace: typeof dispatchFocusRepoWorkspaceTab = dispatchFocusRepoWorkspaceTab,
): 'workspace' | 'fallback' {
  if (focusWorkspace({ repoId: repo.id, repoPath: repo.localPath })) return 'workspace';
  onSelectRepo?.(repo.id);
  return 'fallback';
}
