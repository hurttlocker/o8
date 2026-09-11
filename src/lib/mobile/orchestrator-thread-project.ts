import { getProject } from '@/lib/projects/store';
import { findRepoByIdSync } from '@/lib/repos/registry';
import { virtualProjectRepoId } from '@/lib/repos/virtual-project-id';

/**
 * The JSON-ledger's sentinel project id (`DEFAULT_PROJECT_ID` in
 * `@/lib/repos/projects`). Declared locally rather than imported from the
 * ledger module; `orchestrator-thread-project.test.ts` pins the two together
 * so they cannot drift apart.
 */
export const LEGACY_DEFAULT_PROJECT_ID = 'default';

/**
 * Threads stamp their project id from the JSON ledger, which uses the literal
 * `'default'`. Validation looks the id up in the SQLite `projects` table, and a
 * fresh install has no such row -- so every orchestrator turn failed with
 * "Project default does not exist" before the operator had registered a repo.
 * The first thing someone does on a new install was the thing that broke
 * (#1752).
 *
 * The sentinel is not a project; it means "no project chosen". A thread with a
 * null project is already a supported state, so it resolves to null. An
 * unknown id that is NOT the sentinel is still a genuine error worth raising.
 */
function isUnresolvedLegacyDefault(projectId: string): boolean {
  return projectId === LEGACY_DEFAULT_PROJECT_ID && !getProject(projectId);
}

/**
 * A thread's project id is stamped from the projects ledger, and the ledger
 * resolves ids out of TWO stores: SQLite holds the real projects, and the
 * ledger projects a virtual `repo:<id>` row for every pool repo that belongs
 * to no project. Only SQLite was consulted here, so a single-repo project —
 * which is what every repo is until a second one joins it — was selectable
 * and usable everywhere except an orchestrator turn, where it killed the turn
 * with "Project repo:<id> does not exist" (#2140). Both families resolve on
 * this one path so the single-repo and multi-repo cases cannot drift apart.
 */
function projectIdResolves(projectId: string): boolean {
  const repoId = virtualProjectRepoId(projectId);
  return repoId ? Boolean(findRepoByIdSync(repoId)) : Boolean(getProject(projectId));
}

function unresolvedProjectMessage(projectId: string): string {
  // A virtual id names a pool repo, not a project — say so rather than
  // surfacing the internal `repo:<uuid>` form the operator never typed.
  const repoId = virtualProjectRepoId(projectId);
  return repoId ? `Repo ${repoId} is not registered.` : `Project ${projectId} does not exist.`;
}

export type OrchestratorThreadProjectErrorCode =
  | 'orchestrator_thread_project_invalid'
  | 'orchestrator_thread_project_not_found'
  | 'orchestrator_thread_project_mismatch';

export class OrchestratorThreadProjectError extends Error {
  readonly code: OrchestratorThreadProjectErrorCode;
  readonly projectId: string | null;
  readonly existingProjectId?: string;

  constructor(input: {
    code: OrchestratorThreadProjectErrorCode;
    message: string;
    projectId: string | null;
    existingProjectId?: string;
  }) {
    super(input.message);
    this.name = 'OrchestratorThreadProjectError';
    this.code = input.code;
    this.projectId = input.projectId;
    this.existingProjectId = input.existingProjectId;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      projectId: this.projectId,
      ...(this.existingProjectId ? { existingProjectId: this.existingProjectId } : {}),
    };
  }
}

function validateRequestedProjectId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_invalid',
      message: 'projectId must be a non-empty string when provided.',
      projectId: null,
    });
  }
  const projectId = value.trim();
  if (isUnresolvedLegacyDefault(projectId)) return null;
  if (!projectIdResolves(projectId)) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_not_found',
      message: unresolvedProjectMessage(projectId),
      projectId,
    });
  }
  return projectId;
}

export function resolveOrchestratorThreadProjectId(
  existingValue: unknown,
  requestedValue: unknown,
): string | null {
  const existingRaw = typeof existingValue === 'string' && existingValue.trim()
    ? existingValue.trim()
    : null;
  // A thread persisted before a repo was registered carries the sentinel too,
  // so it has to be normalized on this path as well or those threads keep
  // failing after the operator fixes their setup (#1752).
  const existingProjectId = validateRequestedProjectId(existingRaw);
  const requestedProjectId = validateRequestedProjectId(requestedValue);
  if (existingProjectId && requestedProjectId && existingProjectId !== requestedProjectId) {
    throw new OrchestratorThreadProjectError({
      code: 'orchestrator_thread_project_mismatch',
      message: `Thread belongs to project ${existingProjectId}, not ${requestedProjectId}.`,
      projectId: requestedProjectId,
      existingProjectId,
    });
  }
  return existingProjectId ?? requestedProjectId;
}
