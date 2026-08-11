/**
 * Shared directive scope filter — keeps dispatch context (#743) and the
 * Recall Card UI (`/api/cortex/directives`) on the same membership rules.
 *
 * Tier order, broad → narrow:
 *   1. `scope: global` — always applies
 *   2. `scope: project` — applies when the directive's `projects:` slug list
 *      intersects with the project memberships of the target repo
 *   3. `scope: repo` (or `scope: <repoName>`) — applies when the explicit
 *      `repoName` field or the scope literal matches the target repo's basename
 *
 * Lookups never throw. Project DB / repo registry failures fall back to "skip
 * the project tier" so a misbehaving Projects table never starves repo +
 * global directives.
 */

import 'server-only';

import { basename, resolve } from 'node:path';

import {
  getActiveProjectScopeForRepo,
  type ActiveProjectScope,
} from '@/lib/repos/projects';
import { listRepos } from '@/lib/repos/registry';
import { listProjectsByRepoId } from '@/lib/projects/store';

import type { ParsedDirective } from './parse';

export interface DirectiveProjectScope {
  projectIds: Set<string>;
  projectSlugs: Set<string>;
  repoInActiveProject: boolean;
}

function activeProjectScopeToDirectiveScope(scope: ActiveProjectScope): DirectiveProjectScope {
  return {
    projectIds: new Set([scope.projectId.toLowerCase()]),
    projectSlugs: new Set([scope.projectSlug.toLowerCase()]),
    repoInActiveProject: scope.repoInActiveProject,
  };
}

/**
 * Resolve the set of project slugs that include the given repo path.
 *
 * Three-step lookup, each step swallows failures into an empty result:
 *   1. Read the repo registry.
 *   2. Find the entry whose `localPath` resolves to `repoPath`.
 *   3. Ask the projects store for membership rows by the registry id.
 *
 * Returns an empty Set when the registry, the repo, or the projects DB is
 * unavailable. Project-scoped directives are an additive tier — losing them
 * never breaks repo + global directives.
 */
export async function resolveRepoProjectSlugs(repoPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  const normalized = (() => {
    try { return resolve(repoPath); } catch { return ''; }
  })();
  if (!normalized) return out;

  let repoId: string | null = null;
  try {
    const repos = await listRepos();
    const match = repos.find((r) => {
      try {
        return resolve(r.localPath) === normalized;
      } catch {
        return false;
      }
    });
    repoId = match?.id ?? null;
  } catch {
    return out;
  }
  if (!repoId) return out;

  try {
    const projects = listProjectsByRepoId(repoId);
    for (const project of projects) {
      const slug = project.slug?.toLowerCase().trim();
      if (slug) out.add(slug);
    }
  } catch {
    // Project DB unavailable (migration not applied yet, etc.) — drop tier
    // silently. Other tiers still resolve.
  }
  return out;
}

export async function resolveActiveDirectiveProjectScope(repoPath: string): Promise<DirectiveProjectScope> {
  try {
    return activeProjectScopeToDirectiveScope(await getActiveProjectScopeForRepo(repoPath));
  } catch {
    return {
      projectIds: new Set(),
      projectSlugs: new Set(),
      repoInActiveProject: false,
    };
  }
}

function intersects(values: string[], candidates: Set<string>): boolean {
  for (const value of values) {
    if (candidates.has(value.toLowerCase())) return true;
  }
  return false;
}

/**
 * Pure predicate — does the directive apply to this target repo, given the
 * pre-resolved project slug set? Caller resolves slugs once with
 * `resolveRepoProjectSlugs(repoPath)` and reuses it across the directive list.
 */
export function directiveAppliesToRepo(
  directive: ParsedDirective,
  repoPath: string,
  projectScope: Set<string> | DirectiveProjectScope,
): boolean {
  const repoName = basename(repoPath).toLowerCase();
  const scope = directive.scope.toLowerCase();
  if (scope === 'global' || scope === '') return true;

  if (scope === 'project') {
    if (projectScope instanceof Set) {
      return directive.projects.length > 0 && intersects(directive.projects, projectScope);
    }
    if (!projectScope.repoInActiveProject) return false;
    return intersects(directive.projectIds, projectScope.projectIds)
      || intersects(directive.projects, projectScope.projectSlugs);
  }

  // Repo tier — match either explicit repoName field or `scope: <repoName>`.
  const declaredRepo = (directive.repoName ?? '').toLowerCase();
  if (declaredRepo && declaredRepo === repoName) return true;
  if (scope === repoName) return true;
  return false;
}

/**
 * Convenience: filter a directive list for a target repo. Performs the
 * project-slug lookup once and returns directives in input order.
 *
 * Callers that want a sort/cap apply it on the returned array.
 */
export async function filterDirectivesByRepo(
  directives: ParsedDirective[],
  repoPath: string,
): Promise<ParsedDirective[]> {
  const projectScope = await resolveActiveDirectiveProjectScope(repoPath);
  return directives.filter((d) => directiveAppliesToRepo(d, repoPath, projectScope));
}
