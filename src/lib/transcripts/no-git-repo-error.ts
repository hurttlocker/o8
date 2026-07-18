const NO_GIT_REPO_MARKER = " isn't a Git repository";
const ORCHESTRATOR_ERROR_PREFIX = /^Orchestrator error:\s*/;

export interface NoGitRepoError {
  repoPath: string;
}

export function parseNoGitRepoError(message: string | null | undefined): NoGitRepoError | null {
  if (!message) return null;
  const markerIndex = message.indexOf(NO_GIT_REPO_MARKER);
  if (markerIndex < 0) return null;
  const repoPath = message
    .slice(0, markerIndex)
    .trim()
    .replace(ORCHESTRATOR_ERROR_PREFIX, '')
    .trim();
  // Only an absolute (or home-relative) path is a real repo target. Sibling
  // messages like the dispatch gate's "This folder isn't a Git repository…"
  // carry no path — offering git init on the literal words would 400.
  if (!repoPath.startsWith('/') && !repoPath.startsWith('~')) return null;
  return { repoPath };
}
