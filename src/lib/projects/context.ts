import 'server-only';

import path from 'node:path';

import {
  addRepoToProject,
  createProject,
  listProjects,
  updateProject,
} from '@/lib/projects/store';
import type { ProjectRole, ProjectWithRepos } from '@/lib/projects/types';
import {
  getActiveProjectScopeForRepo,
  getProjectsLedger,
  upsertProjectLedgerRecord,
  type ProjectRecord,
} from '@/lib/repos/projects';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { truncateText } from '@/lib/util/text';

export interface ProjectContextRepo {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  defaultBranch: string;
  role: ProjectRole | null;
  isPrimary: boolean;
  isCurrent: boolean;
  inPanelProject: boolean;
  inSettingsProject: boolean;
}

export interface ProjectContext {
  id: string;
  name: string;
  slug: string;
  runtimeProjectId: string;
  panelProjectId: string;
  settingsProjectId: string | null;
  instructions: string | null;
  repoPaths: string[];
  repos: ProjectContextRepo[];
  primaryRepo: ProjectContextRepo | null;
  currentRepo: ProjectContextRepo | null;
  relatedRepos: ProjectContextRepo[];
  allowedRepoIds: string[];
  repoInProject: boolean;
  files: {
    enabled: boolean;
    items: [];
    note: string;
  };
  source: {
    panelProjectName: string;
    settingsProjectName: string | null;
    syncedFromPanel: boolean;
    warnings: string[];
  };
}

export interface ProjectContextOptions {
  repoPath?: string | null;
  projectId?: string | null;
  primaryRepoId?: string | null;
}

export interface ProjectTaskBriefOptions extends ProjectContextOptions {
  taskTitle?: string | null;
  taskBody?: string | null;
}

const RAIL_IMPORT_PLACEHOLDER = 'Imported from the desktop project rail.';

function normalizeRepoPath(inputPath: string) {
  return path.resolve(inputPath.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
}

function projectNameToSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

function inferRepoRole(repo: RepoRegistryEntry): ProjectRole | null {
  const haystack = `${repo.name} ${repo.localPath} ${repo.remoteUrl ?? ''}`.toLowerCase();
  if (/\b(mobile|ios|android|expo|react-native)\b/.test(haystack)) return 'mobile';
  if (/\b(site|web|marketing|docs)\b/.test(haystack)) return 'site';
  if (/\b(api|server|service)\b/.test(haystack)) return 'service';
  if (/\b(infra|deploy|terraform)\b/.test(haystack)) return 'infra';
  if (/\b(lib|library|sdk|shared)\b/.test(haystack)) return 'library';
  return 'fullstack';
}

function repoByPath(repos: RepoRegistryEntry[]) {
  const map = new Map<string, RepoRegistryEntry>();
  for (const repo of repos) {
    map.set(normalizeRepoPath(repo.localPath), repo);
  }
  return map;
}

function repoById(repos: RepoRegistryEntry[]) {
  return new Map(repos.map((repo) => [repo.id, repo]));
}

function findSettingsProject(
  projects: ProjectWithRepos[],
  panelProject: ProjectRecord,
  scopedRepoId: string | null,
  requestedProjectId: string | null,
): ProjectWithRepos | null {
  const requested = requestedProjectId?.trim().toLowerCase() || null;
  if (requested) {
    const byId = projects.find((project) => project.id.toLowerCase() === requested);
    if (byId) return byId;
    const bySlug = projects.find((project) => project.slug.toLowerCase() === requested);
    if (bySlug) return bySlug;
  }

  if (scopedRepoId) {
    const byRepo = projects.find((project) => project.repos.some((link) => link.repoId === scopedRepoId));
    if (byRepo) return byRepo;
  }

  const panelSlug = projectNameToSlug(panelProject.name);
  return projects.find((project) => project.slug === panelSlug)
    ?? projects.find((project) => project.name.toLowerCase() === panelProject.name.toLowerCase())
    ?? null;
}

function primaryRepoScore(repo: ProjectContextRepo): number {
  switch (repo.role) {
    case 'fullstack':
      return 100;
    case 'backend':
      return 90;
    case 'service':
      return 80;
    case 'frontend':
      return 70;
    case 'shared':
      return 60;
    case 'library':
      return 55;
    case 'mobile':
      return 40;
    case 'site':
      return 35;
    case 'docs':
      return 20;
    case 'infra':
      return 10;
    default:
      return 50;
  }
}

function chooseProjectPrimaryRepo(
  repos: ProjectContextRepo[],
  preferredRepoId: string | null,
): ProjectContextRepo | null {
  if (preferredRepoId) {
    const explicit = repos.find((repo) => repo.id === preferredRepoId);
    if (explicit) return explicit;
  }

  return [...repos].sort((left, right) => {
    const scoreDelta = primaryRepoScore(right) - primaryRepoScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    if (left.inSettingsProject !== right.inSettingsProject) return left.inSettingsProject ? -1 : 1;
    if (left.inPanelProject !== right.inPanelProject) return left.inPanelProject ? -1 : 1;
    return left.name.localeCompare(right.name);
  })[0] ?? null;
}

export async function syncProjectStoreFromPanelLedger(): Promise<{
  createdProjects: number;
  linkedRepos: number;
}> {
  const [ledger, repos] = await Promise.all([getProjectsLedger(), listRepos()]);
  const byPath = repoByPath(repos);
  let projects = listProjects();
  let createdProjects = 0;
  let linkedRepos = 0;

  for (const panelProject of ledger.projects) {
    const slug = projectNameToSlug(panelProject.name);
    let settingsProject = projects.find((project) => project.slug === slug)
      ?? projects.find((project) => project.name.toLowerCase() === panelProject.name.toLowerCase())
      ?? null;

    if (!settingsProject) {
      const created = createProject({
        name: panelProject.name,
        slug,
        description: null,
      });
      settingsProject = { ...created, repos: [] };
      projects = [settingsProject, ...projects];
      createdProjects += 1;
    } else if (settingsProject.description?.startsWith(RAIL_IMPORT_PLACEHOLDER)) {
      const updated = updateProject(settingsProject.id, { description: null });
      if (updated) {
        const cleanedProject = { ...settingsProject, description: updated.description };
        settingsProject = cleanedProject;
        projects = projects.map((project) => (
          project.id === cleanedProject.id ? cleanedProject : project
        ));
      }
    }

    const existingRepoIds = new Set(settingsProject.repos.map((link) => link.repoId));
    for (const repoPath of panelProject.repoPaths) {
      const repo = byPath.get(normalizeRepoPath(repoPath));
      if (!repo || existingRepoIds.has(repo.id)) continue;
      const link = addRepoToProject(settingsProject.id, repo.id, inferRepoRole(repo), 'manual');
      settingsProject.repos.push(link);
      existingRepoIds.add(repo.id);
      linkedRepos += 1;
    }
  }

  return { createdProjects, linkedRepos };
}

export async function syncPanelLedgerFromProjectStore(project: ProjectWithRepos): Promise<void> {
  const repos = await listRepos();
  const byId = repoById(repos);
  const repoPaths = project.repos
    .map((link) => byId.get(link.repoId)?.localPath ?? null)
    .filter((repoPath): repoPath is string => Boolean(repoPath?.trim()))
    .map(normalizeRepoPath);

  await upsertProjectLedgerRecord({
    name: project.name,
    slug: project.slug,
    repoPaths,
  });
}

export async function getProjectContext(options: ProjectContextOptions = {}): Promise<ProjectContext> {
  const [syncResult, repos, ledger] = await Promise.all([
    syncProjectStoreFromPanelLedger(),
    listRepos(),
    getProjectsLedger(),
  ]);
  const projects = listProjects();
  const byPath = repoByPath(repos);
  const byId = repoById(repos);
  const activeScope = await getActiveProjectScopeForRepo(options.repoPath);
  const requestedRepoPath = options.repoPath?.trim() ? normalizeRepoPath(options.repoPath) : null;
  const panelProject = requestedRepoPath
    ? ledger.projects.find((project) => project.repoPaths.some((repoPath) => normalizeRepoPath(repoPath) === requestedRepoPath))
      ?? activeScope.project
    : activeScope.project;
  const explicitPrimaryRepo = options.primaryRepoId ? byId.get(options.primaryRepoId) ?? null : null;
  const currentRepoCandidate = requestedRepoPath ? byPath.get(requestedRepoPath) ?? null : null;
  const settingsProject = findSettingsProject(
    projects,
    panelProject,
    currentRepoCandidate?.id ?? explicitPrimaryRepo?.id ?? null,
    options.projectId ?? null,
  );

  const settingsRoles = new Map<string, ProjectRole | null>();
  for (const link of settingsProject?.repos ?? []) {
    settingsRoles.set(link.repoId, link.role);
  }

  const panelPaths = new Set(panelProject.repoPaths.map(normalizeRepoPath));
  const seenRepoIds = new Set<string>();
  const contextRepos: ProjectContextRepo[] = [];
  const pushRepo = (repo: RepoRegistryEntry, flags: { inPanelProject: boolean; inSettingsProject: boolean }) => {
    if (seenRepoIds.has(repo.id)) return;
    seenRepoIds.add(repo.id);
    const isCurrent = currentRepoCandidate
      ? repo.id === currentRepoCandidate.id
      : requestedRepoPath
        ? normalizeRepoPath(repo.localPath) === requestedRepoPath
        : false;
    contextRepos.push({
      id: repo.id,
      name: repo.name,
      localPath: normalizeRepoPath(repo.localPath),
      remoteUrl: repo.remoteUrl,
      defaultBranch: repo.defaultBranch,
      role: settingsRoles.get(repo.id) ?? null,
      isPrimary: false,
      isCurrent,
      inPanelProject: flags.inPanelProject,
      inSettingsProject: flags.inSettingsProject,
    });
  };

  for (const repoPath of panelPaths) {
    const repo = byPath.get(repoPath);
    if (repo) pushRepo(repo, { inPanelProject: true, inSettingsProject: settingsRoles.has(repo.id) });
  }
  for (const link of settingsProject?.repos ?? []) {
    const repo = byId.get(link.repoId);
    if (repo) pushRepo(repo, { inPanelProject: panelPaths.has(normalizeRepoPath(repo.localPath)), inSettingsProject: true });
  }
  if (currentRepoCandidate) {
    pushRepo(currentRepoCandidate, {
      inPanelProject: panelPaths.has(normalizeRepoPath(currentRepoCandidate.localPath)),
      inSettingsProject: settingsRoles.has(currentRepoCandidate.id),
    });
  }

  const primaryRepo = chooseProjectPrimaryRepo(
    contextRepos,
    explicitPrimaryRepo?.id ?? settingsProject?.mainRepoId ?? null,
  );
  const currentRepo = contextRepos.find((repo) => repo.isCurrent)
    ?? (requestedRepoPath ? null : primaryRepo);
  if (primaryRepo) {
    primaryRepo.isPrimary = true;
  }

  const warnings: string[] = [];
  if (!settingsProject) {
    warnings.push('No Settings project matched the active panel project; using panel project scope only.');
  }
  if (requestedRepoPath && !contextRepos.some((repo) => repo.localPath === requestedRepoPath)) {
    warnings.push('Requested repo is not part of the resolved project context.');
  }
  if (syncResult.createdProjects > 0 || syncResult.linkedRepos > 0) {
    warnings.push(`Synchronized ${syncResult.createdProjects} project(s) and ${syncResult.linkedRepos} repo link(s) from the desktop rail.`);
  }

  const repoInProject = requestedRepoPath
    ? contextRepos.some((repo) => repo.localPath === requestedRepoPath)
    : true;
  const name = settingsProject?.name ?? panelProject.name;
  const slug = settingsProject?.slug ?? projectNameToSlug(panelProject.name);

  return {
    id: settingsProject?.id ?? panelProject.id,
    name,
    slug,
    runtimeProjectId: panelProject.id,
    panelProjectId: panelProject.id,
    settingsProjectId: settingsProject?.id ?? null,
    instructions: settingsProject?.description?.trim() || null,
    repoPaths: contextRepos.map((repo) => repo.localPath),
    repos: contextRepos,
    primaryRepo,
    currentRepo,
    relatedRepos: contextRepos.filter((repo) => repo.id !== primaryRepo?.id),
    allowedRepoIds: contextRepos.map((repo) => repo.id),
    repoInProject,
    files: {
      enabled: false,
      items: [],
      note: 'Project files are not wired yet; repos and instructions are the active project context.',
    },
    source: {
      panelProjectName: panelProject.name,
      settingsProjectName: settingsProject?.name ?? null,
      syncedFromPanel: syncResult.createdProjects > 0 || syncResult.linkedRepos > 0,
      warnings,
    },
  };
}

function formatRepoLabel(repo: ProjectContextRepo) {
  return `${repo.name}${repo.role ? ` [${repo.role}]` : ''}`;
}

export function buildProjectTaskBrief(context: ProjectContext, options: ProjectTaskBriefOptions = {}): string {
  const siblingRepos = context.relatedRepos.filter((repo) => repo.id !== context.currentRepo?.id);
  const lines = [
    `Project: ${context.name} (${context.repos.length} repo${context.repos.length === 1 ? '' : 's'})`,
    context.primaryRepo
      ? `Main repo: ${formatRepoLabel(context.primaryRepo)} at ${context.primaryRepo.localPath}`
      : null,
    context.currentRepo && context.currentRepo.id !== context.primaryRepo?.id
      ? `Current repo: ${formatRepoLabel(context.currentRepo)} at ${context.currentRepo.localPath}`
      : null,
    siblingRepos.length > 0
      ? `Related repos: ${siblingRepos.map(formatRepoLabel).join(', ')}`
      : null,
    context.instructions
      ? `Project instructions: ${truncateText(context.instructions, 700, { normalizeWhitespace: true })}`
      : null,
    options.taskTitle?.trim()
      ? `Task: ${truncateText(options.taskTitle, 240, { normalizeWhitespace: true })}`
      : null,
    options.taskBody?.trim()
      ? `Task detail: ${truncateText(options.taskBody, 700, { normalizeWhitespace: true })}`
      : null,
    'Repo policy: treat the main repo as the product anchor, use the current repo for repo-specific work, read sibling repos as context, and edit sibling repos only when the task explicitly requires cross-repo changes.',
    'Output policy: call out which repo(s) changed, any locks/conflicts encountered, and whether follow-up project wiring is needed.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

export async function buildProjectTaskBriefForOptions(options: ProjectTaskBriefOptions = {}): Promise<string> {
  const context = await getProjectContext(options);
  return buildProjectTaskBrief(context, options);
}
