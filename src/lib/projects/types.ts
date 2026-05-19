/**
 * Projects model — operator-curated repo groupings (epic #899).
 *
 * Replaces the Jaccard-based cross-repo proposer (#748) with explicit
 * Projects: a Project owns N repos, each tagged with a role
 * (frontend / backend / shared / etc.). Directives, outcomes, approvals,
 * and lanes can scope to a project_id so signals propagate across the
 * whole product surface instead of getting trapped in a single repo.
 */

/** Role a repo plays inside a Project. Free-form string in DB; this enum is the curated set. */
export type ProjectRole =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'library'
  | 'service'
  | 'infra'
  | 'docs'
  | 'site'
  | 'shared';

/**
 * Where a project_repos row originated from. The dismissed_suggestions table
 * keys off `ai-semantic` groupings so we don't keep re-suggesting them after
 * the operator says no.
 */
export type SuggestionOrigin = 'manual' | 'github-org' | 'ai-semantic';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  mainRepoId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRepo {
  projectId: string;
  repoId: string;
  role: ProjectRole | null;
  suggestionOrigin: SuggestionOrigin;
  addedAt: number;
}

export interface ProjectWithRepos extends Project {
  repos: ProjectRepo[];
}

export interface DismissedSuggestion {
  fingerprint: string;
  dismissedAt: number;
  reason: string | null;
}
