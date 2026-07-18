import type { RepoFocusRepo } from './repo-focus/types';

export function deriveActiveProjectRepos(
  activeProjectRepoPaths: string[] | null,
  registeredRepos: RepoFocusRepo[],
): RepoFocusRepo[] {
  if (activeProjectRepoPaths === null) return registeredRepos;
  const registeredRepoByPath = new Map(registeredRepos.map((repo) => [repo.localPath, repo]));
  return activeProjectRepoPaths.flatMap((repoPath) => {
    const repo = registeredRepoByPath.get(repoPath);
    return repo ? [repo] : [];
  });
}

export function resolveGlobalNewSessionRepo(
  selectedRepo: RepoFocusRepo | null,
  activeProjectRepos: RepoFocusRepo[],
): RepoFocusRepo | null {
  return selectedRepo ?? activeProjectRepos[0] ?? null;
}

export function canCreateOrchestratorForRepo(repo: RepoFocusRepo | null | undefined): repo is RepoFocusRepo {
  return Boolean(repo && repo.readiness?.state !== 'missing');
}

export function deriveAgentPanelRailRepos(
  activeProjectRepos: RepoFocusRepo[],
  registeredRepos: RepoFocusRepo[],
  projectRepoPaths: Iterable<string>,
): RepoFocusRepo[] {
  const assignedRepoPaths = new Set(projectRepoPaths);
  const visibleRepoPaths = new Set(activeProjectRepos.map((repo) => repo.localPath));
  const railRepos = [...activeProjectRepos];

  for (const repo of registeredRepos) {
    if (assignedRepoPaths.has(repo.localPath) || visibleRepoPaths.has(repo.localPath)) continue;
    visibleRepoPaths.add(repo.localPath);
    railRepos.push(repo);
  }

  return railRepos;
}
