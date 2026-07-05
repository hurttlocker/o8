/**
 * Repo-scope stickiness for orchestrator threads (#1421). The chat-history
 * POST used to let any body.repoPath clobber the persisted thread scope on
 * every save — a send from a stale client rebound the titlebar repo. An
 * existing thoughts-thread keeps its persisted repo; only new threads take
 * the posted scope. Lives outside the route file because Next route modules
 * may only export HTTP verbs + config.
 */

function isThoughtsThread(tabId: unknown): tabId is string {
  return typeof tabId === 'string' && tabId.startsWith('thoughts-');
}

export function resolveThreadRepoMetadata(input: {
  tabId: unknown;
  existingRepoPath?: string;
  existingRepoName?: string;
  existingRepoBranch?: string;
  bodyRepoPath?: unknown;
  bodyRepoName?: unknown;
  bodyRepoBranch?: unknown;
}) {
  const stickyRepoPath = isThoughtsThread(input.tabId)
    && typeof input.existingRepoPath === 'string'
    && input.existingRepoPath.trim()
    ? input.existingRepoPath
    : undefined;

  if (stickyRepoPath) {
    return {
      repoPath: stickyRepoPath,
      repoName: input.existingRepoName,
      repoBranch: input.existingRepoBranch,
    };
  }

  return {
    repoPath: input.bodyRepoPath ?? input.existingRepoPath,
    repoName: input.bodyRepoName ?? input.existingRepoName,
    repoBranch: input.bodyRepoBranch ?? input.existingRepoBranch,
  };
}
