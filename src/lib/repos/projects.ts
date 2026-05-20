import 'server-only';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readRepoPathRegistry } from './repo-path-registry';
import { listProjects as listSqliteProjects } from '@/lib/projects/store';
import { listRepos } from './registry';

const PROJECTS_DIR = path.join(os.homedir(), '.o8');
const PROJECTS_PATH = path.join(PROJECTS_DIR, 'projects.json');
export const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_PROJECT_NAME = 'Workspace';

/**
 * Curated palette for project dots. Hex strings rather than tailwind tokens
 * so the color renders identically in every theme + the picker, and so the
 * persisted ledger is portable across versions.
 */
export const PROJECT_COLOR_PALETTE = [
  '#5b8db8', // slate blue
  '#7fa68f', // sage
  '#a39565', // amber
  '#a37b7b', // rose
  '#9079a8', // muted violet
  '#7a9a8c', // teal
  '#a87f5b', // ochre
  '#7a87a3', // steel
] as const;

export type ProjectColor = typeof PROJECT_COLOR_PALETTE[number];

export interface ProjectRecord {
  id: string;
  name: string;
  repoPaths: string[];
  createdAt: string;
  color?: ProjectColor;
}

export interface ProjectsLedger {
  projects: ProjectRecord[];
  activeProjectId: string;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `prj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRepoPath(inputPath: string) {
  const expanded = inputPath.trim().replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(expanded);
}

function projectNameToSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || DEFAULT_PROJECT_ID;
}

function repoPathBelongsToProject(project: ProjectRecord, repoPath: string): boolean {
  const normalized = normalizeRepoPath(repoPath);
  return project.repoPaths.some((candidate) => normalizeRepoPath(candidate) === normalized);
}

function normalizeProjectRecord(entry: ProjectRecord): ProjectRecord {
  return {
    id: entry.id,
    name: entry.name,
    repoPaths: entry.repoPaths.map(normalizeRepoPath),
    createdAt: entry.createdAt ?? nowIso(),
    color: PROJECT_COLOR_PALETTE.includes(entry.color as ProjectColor) ? entry.color : undefined,
  };
}

function preferConcreteActiveProject(ledger: ProjectsLedger): ProjectsLedger {
  if (ledger.activeProjectId !== DEFAULT_PROJECT_ID) return ledger;
  const concreteProject = ledger.projects.find((project) => project.id !== DEFAULT_PROJECT_ID);
  return concreteProject ? { ...ledger, activeProjectId: concreteProject.id } : ledger;
}

function ensureDir() {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
  }
}

async function readRawLedger(): Promise<ProjectsLedger | null> {
  try {
    const raw = await readFile(PROJECTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectsLedger> | null;
    if (!parsed || !Array.isArray(parsed.projects)) return null;
    const projects = parsed.projects
      .filter((entry): entry is ProjectRecord => (
        Boolean(entry)
        && typeof entry === 'object'
        && typeof (entry as ProjectRecord).id === 'string'
        && typeof (entry as ProjectRecord).name === 'string'
        && Array.isArray((entry as ProjectRecord).repoPaths)
      ))
      .map(normalizeProjectRecord);
    if (projects.length === 0) return null;
    const activeProjectId = typeof parsed.activeProjectId === 'string'
      && projects.some((p) => p.id === parsed.activeProjectId)
      ? parsed.activeProjectId
      : projects[0]!.id;
    return { projects, activeProjectId };
  } catch {
    return null;
  }
}

async function writeLedger(ledger: ProjectsLedger) {
  ensureDir();
  await writeFile(PROJECTS_PATH, JSON.stringify(ledger, null, 2), 'utf8');
}

async function bootstrapDefaultLedger(): Promise<ProjectsLedger> {
  const registry = await readRepoPathRegistry();
  const repoPaths = registry.ok ? registry.repos.map((entry) => normalizeRepoPath(entry.path)) : [];
  const ledger: ProjectsLedger = {
    projects: [{
      id: DEFAULT_PROJECT_ID,
      name: DEFAULT_PROJECT_NAME,
      repoPaths,
      createdAt: nowIso(),
      color: PROJECT_COLOR_PALETTE[0],
    }],
    activeProjectId: DEFAULT_PROJECT_ID,
  };
  await writeLedger(ledger);
  return ledger;
}

export async function getProjectsLedger(): Promise<ProjectsLedger> {
  const existing = await readRawLedger();
  const base = existing ?? await bootstrapDefaultLedger();
  return enrichLedgerWithSqliteRepoPaths(base);
}

/**
 * Live-derive `repoPaths` for each project from the SQLite project_repos
 * table so the panel ledger never lags behind the settings dialog. SQLite
 * is the canonical store for project↔repo membership; the JSON ledger now
 * acts as a metadata sidecar (activeProjectId + color + ordering).
 *
 * Projects unique to the JSON ledger (no SQLite slug match) keep their
 * stored repoPaths so legacy data isn't silently dropped.
 */
async function enrichLedgerWithSqliteRepoPaths(ledger: ProjectsLedger): Promise<ProjectsLedger> {
  let sqliteProjects;
  try {
    sqliteProjects = listSqliteProjects();
  } catch {
    return ledger;
  }
  if (sqliteProjects.length === 0) return ledger;

  let repos;
  try {
    repos = await listRepos();
  } catch {
    return ledger;
  }
  const repoById = new Map(repos.map((repo) => [repo.id, repo]));

  const repoPathsBySlug = new Map<string, string[]>();
  for (const sp of sqliteProjects) {
    const paths = sp.repos
      .map((link) => repoById.get(link.repoId)?.localPath ?? null)
      .filter((repoPath): repoPath is string => Boolean(repoPath?.trim()))
      .map(normalizeRepoPath);
    repoPathsBySlug.set(sp.slug, paths);
  }

  return {
    ...ledger,
    projects: ledger.projects.map((project) => {
      const slug = projectNameToSlug(project.name);
      const fresh = repoPathsBySlug.get(slug);
      return fresh !== undefined ? { ...project, repoPaths: fresh } : project;
    }),
  };
}

export function getProjectsLedgerSync(): ProjectsLedger {
  try {
    const raw = readFileSync(PROJECTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectsLedger> | null;
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('Invalid projects ledger');
    const projects = parsed.projects
      .filter((entry): entry is ProjectRecord => (
        Boolean(entry)
        && typeof entry === 'object'
        && typeof (entry as ProjectRecord).id === 'string'
        && typeof (entry as ProjectRecord).name === 'string'
        && Array.isArray((entry as ProjectRecord).repoPaths)
      ))
      .map(normalizeProjectRecord);
    if (projects.length === 0) throw new Error('Empty projects ledger');
    const activeProjectId = typeof parsed.activeProjectId === 'string'
      && projects.some((p) => p.id === parsed.activeProjectId)
      ? parsed.activeProjectId
      : projects[0]!.id;
    return { projects, activeProjectId };
  } catch {
    return {
      projects: [{
        id: DEFAULT_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        repoPaths: [],
        createdAt: nowIso(),
        color: PROJECT_COLOR_PALETTE[0],
      }],
      activeProjectId: DEFAULT_PROJECT_ID,
    };
  }
}

export interface ActiveProjectScope {
  project: ProjectRecord;
  projectId: string;
  projectSlug: string;
  repoPaths: string[];
  repoInActiveProject: boolean;
}

export function getActiveProjectScopeForRepoSync(repoPath?: string | null): ActiveProjectScope {
  const ledger = getProjectsLedgerSync();
  const activeProject = ledger.projects.find((candidate) => candidate.id === ledger.activeProjectId)
    ?? ledger.projects[0]!;
  const project = repoPath
    ? ledger.projects.find((candidate) => repoPathBelongsToProject(candidate, repoPath)) ?? activeProject
    : activeProject;
  const repoInActiveProject = repoPath ? repoPathBelongsToProject(project, repoPath) : false;
  return {
    project,
    projectId: project.id,
    projectSlug: projectNameToSlug(project.name),
    repoPaths: project.repoPaths.map(normalizeRepoPath),
    repoInActiveProject,
  };
}

export async function getActiveProjectScopeForRepo(repoPath?: string | null): Promise<ActiveProjectScope> {
  const ledger = await getProjectsLedger();
  const activeProject = ledger.projects.find((candidate) => candidate.id === ledger.activeProjectId)
    ?? ledger.projects[0]!;
  const project = repoPath
    ? ledger.projects.find((candidate) => repoPathBelongsToProject(candidate, repoPath)) ?? activeProject
    : activeProject;
  const repoInActiveProject = repoPath ? repoPathBelongsToProject(project, repoPath) : false;
  return {
    project,
    projectId: project.id,
    projectSlug: projectNameToSlug(project.name),
    repoPaths: project.repoPaths.map(normalizeRepoPath),
    repoInActiveProject,
  };
}

export async function setActiveProject(projectId: string): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  if (!ledger.projects.some((p) => p.id === projectId)) {
    throw new Error(`Project ${projectId} does not exist.`);
  }
  const next: ProjectsLedger = { ...ledger, activeProjectId: projectId };
  await writeLedger(next);
  return next;
}

function pickAutoColor(used: Set<ProjectColor | undefined>): ProjectColor {
  for (const candidate of PROJECT_COLOR_PALETTE) {
    if (!used.has(candidate)) return candidate;
  }
  return PROJECT_COLOR_PALETTE[0];
}

export async function createProject(name: string): Promise<ProjectsLedger> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  if (trimmed.length > 60) throw new Error('Project name must be 60 characters or fewer.');
  const ledger = await getProjectsLedger();
  const used = new Set<ProjectColor | undefined>(ledger.projects.map((p) => p.color));
  const project: ProjectRecord = {
    id: makeId(),
    name: trimmed,
    repoPaths: [],
    createdAt: nowIso(),
    color: pickAutoColor(used),
  };
  const next: ProjectsLedger = {
    projects: [...ledger.projects, project],
    activeProjectId: project.id,
  };
  await writeLedger(next);
  return next;
}

export async function setProjectColor(projectId: string, color: ProjectColor): Promise<ProjectsLedger> {
  if (!PROJECT_COLOR_PALETTE.includes(color)) {
    throw new Error('Unknown project color.');
  }
  const ledger = await getProjectsLedger();
  const next: ProjectsLedger = {
    ...ledger,
    projects: ledger.projects.map((p) => (p.id === projectId ? { ...p, color } : p)),
  };
  await writeLedger(next);
  return next;
}

export async function renameProject(projectId: string, name: string): Promise<ProjectsLedger> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  const ledger = await getProjectsLedger();
  const next: ProjectsLedger = {
    ...ledger,
    projects: ledger.projects.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)),
  };
  await writeLedger(next);
  return next;
}

export async function deleteProject(projectId: string): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  if (ledger.projects.length <= 1) {
    throw new Error('Cannot delete the only project.');
  }
  const remaining = ledger.projects.filter((p) => p.id !== projectId);
  const activeProjectId = ledger.activeProjectId === projectId ? remaining[0]!.id : ledger.activeProjectId;
  const next: ProjectsLedger = { projects: remaining, activeProjectId };
  await writeLedger(next);
  return next;
}

export async function setProjectRepos(projectId: string, repoPaths: string[]): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const normalized = Array.from(new Set(repoPaths.map(normalizeRepoPath)));
  const next: ProjectsLedger = {
    ...ledger,
    projects: ledger.projects.map((p) => (p.id === projectId ? { ...p, repoPaths: normalized } : p)),
  };
  await writeLedger(next);
  return next;
}

export async function removeRepoPathFromProjects(repoPath: string): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  let mutated = false;
  const projects = ledger.projects.map((project) => {
    const repoPaths = project.repoPaths.filter((candidate) => normalizeRepoPath(candidate) !== normalizedRepoPath);
    if (repoPaths.length !== project.repoPaths.length) {
      mutated = true;
      return { ...project, repoPaths };
    }
    return project;
  });
  const next = preferConcreteActiveProject({ ...ledger, projects });
  if (!mutated && next.activeProjectId === ledger.activeProjectId) return ledger;
  await writeLedger(next);
  return next;
}

export async function upsertProjectLedgerRecord(input: {
  id?: string | null;
  name: string;
  slug?: string | null;
  repoPaths: string[];
}): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const normalized = Array.from(new Set(input.repoPaths.map(normalizeRepoPath)));
  const targetSlug = input.slug?.trim() || projectNameToSlug(input.name);
  const existingIndex = ledger.projects.findIndex((project) => (
    (input.id && project.id === input.id)
    || projectNameToSlug(project.name) === targetSlug
    || project.name.toLowerCase() === input.name.toLowerCase()
  ));

  if (existingIndex >= 0) {
    const nextProjects = ledger.projects.map((project, index) => (
      index === existingIndex
        ? {
            ...project,
            repoPaths: normalized,
          }
        : project
    ));
    const next: ProjectsLedger = { ...ledger, projects: nextProjects };
    await writeLedger(next);
    return next;
  }

  const used = new Set<ProjectColor | undefined>(ledger.projects.map((project) => project.color));
  const project: ProjectRecord = {
    id: input.id?.trim() || makeId(),
    name: input.name.trim(),
    repoPaths: normalized,
    createdAt: nowIso(),
    color: pickAutoColor(used),
  };
  const next: ProjectsLedger = {
    ...ledger,
    projects: [...ledger.projects, project],
  };
  await writeLedger(next);
  return next;
}

/**
 * Reconcile the panel ledger's view of repoPaths with the global registry.
 *
 * Historical behavior: orphan repos (in registry, not in any project) got
 * auto-added to the active project. That fought explicit project-membership
 * management — removing a repo from a project caused it to be re-added on
 * the next API read. Now we only strip dead paths (paths no longer in the
 * registry) and leave orphans alone. New repos must be added to projects
 * explicitly at the add-repo callsite.
 *
 * Since `getProjectsLedger()` already lives-derives repoPaths from SQLite,
 * the file-write here is mostly a no-op unless the activeProjectId or a
 * project unique to the JSON ledger needed dead-path cleanup.
 */
export async function reconcileProjectsWithRegistry(): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    const normalizedActive = preferConcreteActiveProject(ledger);
    if (normalizedActive.activeProjectId !== ledger.activeProjectId) {
      await writeLedger(normalizedActive);
      return normalizedActive;
    }
    return ledger;
  }
  const knownPaths = new Set(registry.repos.map((entry) => normalizeRepoPath(entry.path)));
  // Strip stale paths that no longer exist in the registry from each project.
  // No more orphan-add — orphans stay orphans until explicit project assignment.
  let mutated = false;
  const projects = ledger.projects.map((project) => {
    const filtered = project.repoPaths.filter((p) => knownPaths.has(p));
    if (filtered.length !== project.repoPaths.length) {
      mutated = true;
      return { ...project, repoPaths: filtered };
    }
    return project;
  });
  if (mutated) {
    const next = preferConcreteActiveProject({ ...ledger, projects });
    await writeLedger(next);
    return next;
  }
  const normalizedActive = preferConcreteActiveProject(ledger);
  if (normalizedActive.activeProjectId !== ledger.activeProjectId) {
    await writeLedger(normalizedActive);
    return normalizedActive;
  }
  return ledger;
}
