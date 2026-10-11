import 'server-only';

import path from 'node:path';
import { realpathSync } from 'node:fs';

import { getProjectContext, type ProjectContext } from '@/lib/projects/context';
import { isGeneratedProjectId, listProjects } from '@/lib/projects/store';
import { DEFAULT_PROJECT_ID, getProjectsLedger } from '@/lib/repos/projects';
import { listRepos } from '@/lib/repos/registry';
import { isVirtualRepoProjectId } from '@/lib/repos/virtual-project-id';
import { taskPanelProjectId } from '@/lib/tasks/panel-project-identity';

function physicalPath(value: string): string {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

export class MissionProjectScopeError extends Error {
  readonly code = 'mission_project_scope_invalid';
}

/** Capture once at creation. Thread ids convey placement/rules, not project authority. */
export async function captureMissionProject(repoPath: string, requested?: string | null): Promise<ProjectContext | null> {
  if (requested !== undefined && requested !== null && (typeof requested !== 'string' || !requested.trim())) {
    throw new MissionProjectScopeError('projectId must be a non-empty project identifier.');
  }
  const [ledger, repos] = await Promise.all([getProjectsLedger(), listRepos()]);
  const normalizedPath = physicalPath(repoPath);
  const registered = repos.some((repo) => physicalPath(repo.localPath) === normalizedPath);
  if (!registered && !requested) return null; // Existing outside-launch transient repositories.
  let projectId = requested?.trim();
  if (!projectId) {
    const candidates = ledger.projects.filter((project) => project.repoPaths.some((entry) => physicalPath(entry) === normalizedPath));
    const active = candidates.find((project) => project.id === ledger.activeProjectId);
    if (!active && candidates.length !== 1) {
      throw new MissionProjectScopeError('Select an explicit projectId for this repository before creating a mission.');
    }
    projectId = (active ?? candidates[0]).id;
  }
  // Accept a panel identity only through its unique name+slug mapping to SQLite.
  // Never feed a raw panel id into the permissive slug resolver (including default).
  const settings = listProjects();
  const exact = settings.find((project) => project.id === projectId);
  if (!exact && isGeneratedProjectId(projectId)) {
    throw new MissionProjectScopeError('The selected canonical project no longer exists.');
  }
  const panel = ledger.projects.find((project) => project.id === projectId);
  let canonicalId = exact?.id;
  if (!canonicalId && panel && !isVirtualRepoProjectId(panel.id)) {
    const slug = panel.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    const aliases = settings.filter((project) => project.slug === slug
      && project.name.toLowerCase() === panel.name.toLowerCase());
    if (aliases.length === 1) canonicalId = aliases[0].id;
    else if (aliases.length > 1 || panel.id !== DEFAULT_PROJECT_ID) {
      throw new MissionProjectScopeError('The selected project has no unique authoritative project record.');
    }
  }
  if (!canonicalId && (!panel || (projectId !== DEFAULT_PROJECT_ID && !isVirtualRepoProjectId(projectId)))) {
    throw new MissionProjectScopeError('The selected project no longer exists or has no authoritative project record.');
  }
  let context: ProjectContext;
  try {
    context = await getProjectContext({ repoPath: normalizedPath, projectId: canonicalId ?? projectId });
  } catch {
    throw new MissionProjectScopeError('The selected project no longer exists.');
  }
  if ((!canonicalId && !isVirtualRepoProjectId(projectId) && context.settingsProjectId !== null)
    || !context.repoInProject || !taskPanelProjectId(context, ledger.projects)) {
    throw new MissionProjectScopeError('The repository is outside the selected project or its identity is ambiguous.');
  }
  return context;
}

/** Persisted packet identities are canonical; never remap a deleted id to a replacement. */
export async function resolveCapturedMissionProject(repoPath: string, projectId: string): Promise<ProjectContext> {
  const context = await captureMissionProject(repoPath, projectId);
  if (!context || context.id !== projectId) {
    throw new MissionProjectScopeError('The captured project identity changed or no longer exists.');
  }
  return context;
}
