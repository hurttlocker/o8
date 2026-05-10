import 'server-only';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readRepoPathRegistry } from './repo-path-registry';

const PROJECTS_DIR = path.join(os.homedir(), '.o8');
const PROJECTS_PATH = path.join(PROJECTS_DIR, 'projects.json');
export const DEFAULT_PROJECT_ID = 'default';
const DEFAULT_PROJECT_NAME = 'o8';

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
  if (existing) return existing;
  return bootstrapDefaultLedger();
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
  const project = ledger.projects.find((candidate) => candidate.id === ledger.activeProjectId)
    ?? ledger.projects[0]!;
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
  const project = ledger.projects.find((candidate) => candidate.id === ledger.activeProjectId)
    ?? ledger.projects[0]!;
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

/**
 * Reconcile the active project's repoPaths with the global repo registry.
 * If new repos appear in the global registry that aren't in any project, they
 * land in the active project so they remain visible.
 */
export async function reconcileProjectsWithRegistry(): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const registry = await readRepoPathRegistry();
  if (!registry.ok) return ledger;
  const knownPaths = new Set(registry.repos.map((entry) => normalizeRepoPath(entry.path)));
  const claimed = new Set<string>();
  for (const project of ledger.projects) {
    for (const repoPath of project.repoPaths) claimed.add(repoPath);
  }
  const orphans = [...knownPaths].filter((p) => !claimed.has(p));
  if (orphans.length === 0) {
    // Strip stale paths that no longer exist in the registry from each project.
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
      const next: ProjectsLedger = { ...ledger, projects };
      await writeLedger(next);
      return next;
    }
    return ledger;
  }
  const projects = ledger.projects.map((project) => {
    if (project.id !== ledger.activeProjectId) {
      return { ...project, repoPaths: project.repoPaths.filter((p) => knownPaths.has(p)) };
    }
    const merged = Array.from(new Set([...project.repoPaths.filter((p) => knownPaths.has(p)), ...orphans]));
    return { ...project, repoPaths: merged };
  });
  const next: ProjectsLedger = { ...ledger, projects };
  await writeLedger(next);
  return next;
}
