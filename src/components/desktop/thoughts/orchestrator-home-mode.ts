export const ORCHESTRATOR_HOME_REPO_SENTINEL = '~';

export function resolveOrchestratorClientRepoPath(repoPath: string | null | undefined): string {
  return repoPath?.trim() || ORCHESTRATOR_HOME_REPO_SENTINEL;
}
