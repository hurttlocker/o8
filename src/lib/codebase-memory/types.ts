/**
 * Types for the codebase-memory boot indexer.
 *
 * Closes #741. The boot indexer reads ~/.o8/repos.json, spawns
 * codebase-memory-mcp per repo, and calls index_repository so the
 * Recall card (#742) has data available when the user dispatches.
 */

export type RepoIndexStatus =
  | 'pending'      // queued, waiting for slot or binary
  | 'indexing'    // index_repository in flight
  | 'ready'       // indexed successfully (HEAD recorded)
  | 'cached'      // skipped because HEAD unchanged
  | 'deferred'    // size > limit, deferred to manual re-index
  | 'skipped'     // binary unavailable / not a git repo / similar
  | 'error';      // index_repository failed

export interface RepoIndexEntry {
  repoId: string;
  repoName: string;
  localPath: string;
  status: RepoIndexStatus;
  /** Last git HEAD we successfully indexed against. */
  lastIndexedHead?: string | null;
  /** Last successful index timestamp (ISO). */
  lastIndexedAt?: string | null;
  /** Most recent error message if status === 'error'. */
  error?: string | null;
  /** Repo size on disk in bytes (only set when measured). */
  sizeBytes?: number | null;
  /** Wall-clock duration of the last index_repository call. */
  durationMs?: number | null;
}

export interface IndexState {
  /** True when the boot pass has scheduled work for every repo. */
  bootRan: boolean;
  /** True while at least one repo is in 'pending' or 'indexing'. */
  inFlight: boolean;
  entries: RepoIndexEntry[];
}

/** Persisted shape at ~/.o8/codebase-memory-state.json. */
export interface PersistedIndexState {
  version: 1;
  /** Map of repoId → last indexed git HEAD. */
  heads: Record<string, { head: string; indexedAt: string }>;
}
