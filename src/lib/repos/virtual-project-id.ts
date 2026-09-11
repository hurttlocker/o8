/**
 * The projects ledger projects a VIRTUAL single-repo project for every pool
 * repo that belongs to no project, under the id `repo:<repoId>`. Nothing
 * persists those rows — `writeLedger` filters them out and the projection
 * re-derives them on every read — so they live only in the ledger's read
 * model, which is also what the sidebar shows and what the composer stamps
 * onto a thread.
 *
 * The shape lives here, clear of the repo-pool graph, so every store that has
 * to recognize one of these ids agrees on it without importing the ledger
 * (#2140 — the orchestrator validated thread project ids against SQLite only,
 * where a virtual id has no row).
 */
export const VIRTUAL_REPO_PROJECT_PREFIX = 'repo:';

/** Id of the virtual single-repo project projected for `repoId`. */
export function virtualRepoProjectId(repoId: string): string {
  return `${VIRTUAL_REPO_PROJECT_PREFIX}${repoId}`;
}

export function isVirtualRepoProjectId(projectId: string): boolean {
  return projectId.startsWith(VIRTUAL_REPO_PROJECT_PREFIX);
}

/** The pool repo id behind a virtual project id; null for any other id. */
export function virtualProjectRepoId(projectId: string): string | null {
  if (!isVirtualRepoProjectId(projectId)) return null;
  return projectId.slice(VIRTUAL_REPO_PROJECT_PREFIX.length) || null;
}
