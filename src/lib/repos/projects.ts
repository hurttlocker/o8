import 'server-only';

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { readRepoPathRegistry } from './repo-path-registry';
import {
  createProject as createSqliteProject,
  deleteProject as deleteSqliteProject,
  getProjectBySlug as getSqliteProjectBySlug,
  getProjectWithRepos as getSqliteProjectWithRepos,
  listProjects as listSqliteProjects,
  updateProject as updateSqliteProject,
} from '@/lib/projects/store';
import { listRepos } from './registry';
import { removeRepoFromPool } from './remove';
import { reconcileSqliteProjectRepos } from './project-membership';

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

/** The effective active project — concrete project preferred over the legacy
 *  `default` so the agent context resolves the same project the dashboard shows. */
function resolveActiveProject(ledger: ProjectsLedger): ProjectRecord {
  const preferred = preferConcreteActiveProject(ledger);
  return preferred.projects.find((candidate) => candidate.id === preferred.activeProjectId)
    ?? preferred.projects[0]!;
}

function ensureDir() {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
  }
}

// ── #1099 Phase 2 — SQLite overlay for ledger metadata ──

interface SqliteProjectMeta {
  byId: Map<string, { color: string | null; sortOrder: number | null }>;
  bySlug: Map<string, { color: string | null; sortOrder: number | null }>;
  activeProjectId: string | null;
}

/**
 * Sync-read the color / sort_order / active_project_id values from SQLite.
 * Returns null on any error so the caller falls back to the JSON ledger —
 * we never want a SQLite hiccup to nuke the project switcher.
 */
function readSqliteProjectMeta(): SqliteProjectMeta | null {
  try {
    const sqlite = getSqlite();
    const rows = sqlite.prepare(
      'SELECT id, slug, color, sort_order FROM projects',
    ).all() as Array<{ id: string; slug: string; color: string | null; sort_order: number | null }>;
    const byId = new Map<string, { color: string | null; sortOrder: number | null }>();
    const bySlug = new Map<string, { color: string | null; sortOrder: number | null }>();
    for (const row of rows) {
      const entry = { color: row.color, sortOrder: row.sort_order };
      byId.set(row.id, entry);
      bySlug.set(row.slug, entry);
    }
    const activeRow = sqlite.prepare(
      "SELECT value FROM app_state WHERE key = 'active_project_id' LIMIT 1",
    ).get() as { value: string } | undefined;
    return {
      byId,
      bySlug,
      activeProjectId: activeRow?.value ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Overlay SQLite-canonical metadata (color, sort_order, active_project_id)
 * onto a JSON-sourced ledger. Behavior-preserving when SQLite has no data
 * for a project — that project keeps its JSON values.
 */
function overlayLedgerWithSqliteMeta(ledger: ProjectsLedger): ProjectsLedger {
  const meta = readSqliteProjectMeta();
  if (!meta || (meta.byId.size === 0 && !meta.activeProjectId)) return ledger;

  // Decorate each project with the SQLite color when present. Look up by id
  // first (the SQLite id), then by slug (handles ledger-only rows like the
  // legacy 'default' that pre-date the SQLite project surface).
  const decorated = ledger.projects.map((project) => {
    const slugCandidate = projectNameToSlug(project.name);
    const matched = meta.byId.get(project.id) ?? meta.bySlug.get(slugCandidate);
    if (!matched) return project;
    const color = matched.color && PROJECT_COLOR_PALETTE.includes(matched.color as ProjectColor)
      ? matched.color as ProjectColor
      : project.color;
    return { ...project, color, _sortOrder: matched.sortOrder ?? undefined } as ProjectRecord & { _sortOrder?: number };
  });

  // Stable sort by SQLite sort_order when present (ledger projects without a
  // sort_order keep their relative order — append after the sorted block).
  const withOrder = decorated.filter((p): p is ProjectRecord & { _sortOrder: number } => (
    typeof (p as { _sortOrder?: number })._sortOrder === 'number'
  ));
  const withoutOrder = decorated.filter((p) => typeof (p as { _sortOrder?: number })._sortOrder !== 'number');
  withOrder.sort((a, b) => a._sortOrder - b._sortOrder);
  const projects = [...withOrder, ...withoutOrder].map((entry) => {
    // Strip the transient _sortOrder field before returning.
    const { _sortOrder: _unused, ...rest } = entry as ProjectRecord & { _sortOrder?: number };
    void _unused;
    return rest;
  });

  return {
    projects,
    activeProjectId: meta.activeProjectId ?? ledger.activeProjectId,
  };
}

/**
 * Write the migrated metadata (color, sort_order, active_project_id) back to
 * SQLite alongside the JSON write. Best-effort — failures log and continue
 * so the JSON write remains the operator-visible source of truth.
 */
function writeSqliteProjectMeta(ledger: ProjectsLedger): void {
  try {
    const sqlite = getSqlite();
    const now = Date.now();
    const updateById = sqlite.prepare(
      'UPDATE projects SET color = ?, sort_order = ? WHERE id = ?',
    );
    const updateBySlug = sqlite.prepare(
      'UPDATE projects SET color = ?, sort_order = ? WHERE slug = ?',
    );
    ledger.projects.forEach((project, index) => {
      if (project.id.startsWith('repo:')) return;
      const color = project.color ?? null;
      const sortOrder = index;
      const res = updateById.run(color, sortOrder, project.id);
      if (res.changes === 0) {
        updateBySlug.run(color, sortOrder, projectNameToSlug(project.name));
      }
    });
    if (ledger.activeProjectId) {
      sqlite.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES ('active_project_id', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(ledger.activeProjectId, now);
    }
  } catch (err) {
    console.warn(
      `[projects] SQLite metadata write failed (JSON persisted normally): ${err instanceof Error ? err.message : String(err)}`,
    );
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
    // Preserve the stored active id even if it isn't among the stored project
    // records — it may reference an appended SQLite project or a virtual
    // single-repo project. getProjectsLedger finalizes it against the projection.
    const activeProjectId = typeof parsed.activeProjectId === 'string' && parsed.activeProjectId
      ? parsed.activeProjectId
      : projects[0]!.id;
    // #1099 Phase 2 — overlay SQLite-canonical metadata (color, sort_order,
    // active_project_id). SQLite is the source of truth for these 3 fields;
    // the JSON read keeps providing project shape + membership history.
    return overlayLedgerWithSqliteMeta({ projects, activeProjectId });
  } catch {
    return null;
  }
}

async function writeLedger(ledger: ProjectsLedger) {
  ensureDir();
  // Never persist virtual single-repo projections (id 'repo:*') — they're
  // derived at read time from unassigned pool repos.
  const persistable: ProjectsLedger = {
    ...ledger,
    projects: ledger.projects.filter((p) => !p.id.startsWith('repo:')),
  };
  await writeFile(PROJECTS_PATH, JSON.stringify(persistable, null, 2), 'utf8');
  // #1099 Phase 2 — mirror the migrated metadata into SQLite so the overlay
  // reads see fresh values. Best-effort: the JSON write is the authoritative
  // surface; SQLite failure logs + continues.
  writeSqliteProjectMeta(persistable);
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
  const enriched = await enrichLedgerWithSqliteRepoPaths(base);
  // Finalize the active id against the FULL projected list (incl. appended +
  // virtual single-repo projects). If it's missing, or it's the legacy default
  // while a concrete project exists, prefer a concrete (non-virtual) project.
  const hasActive = enriched.projects.some((p) => p.id === enriched.activeProjectId);
  if (!hasActive || enriched.activeProjectId === DEFAULT_PROJECT_ID) {
    const concrete = enriched.projects.find((p) => p.id !== DEFAULT_PROJECT_ID && !p.id.startsWith('repo:'))
      ?? enriched.projects.find((p) => p.id !== DEFAULT_PROJECT_ID)
      ?? enriched.projects[0];
    if (concrete) return { ...enriched, activeProjectId: concrete.id };
  }
  return enriched;
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

  const pathsFor = (sp: (typeof sqliteProjects)[number]) => sp.repos
    .map((link) => repoById.get(link.repoId)?.localPath ?? null)
    .filter((repoPath): repoPath is string => Boolean(repoPath?.trim()))
    .map(normalizeRepoPath);

  const repoPathsBySlug = new Map<string, string[]>();
  const sqliteProjectById = new Map(sqliteProjects.map((project) => [project.id, project]));
  const sqliteProjectBySlug = new Map(sqliteProjects.map((project) => [project.slug, project]));
  for (const sp of sqliteProjects) {
    repoPathsBySlug.set(sp.slug, pathsFor(sp));
  }

  // Override matched projects' repoPaths from SQLite (the canonical membership store).
  const representedSqliteProjectIds = new Set<string>();
  const projects: ProjectRecord[] = ledger.projects.map((project) => {
    const slug = projectNameToSlug(project.name);
    const matched = sqliteProjectById.get(project.id)
      ?? (() => {
        const bySlug = sqliteProjectBySlug.get(slug);
        return bySlug?.name.toLowerCase() === project.name.toLowerCase() ? bySlug : undefined;
      })();
    if (matched) representedSqliteProjectIds.add(matched.id);
    const fresh = matched ? repoPathsBySlug.get(matched.slug) : undefined;
    // SQLite is the membership source of truth: a ledger project with no SQLite
    // match owns no repos. Don't keep stale stored repoPaths — that's what kept
    // a repo "assigned" to a deleted project and hid it from the single-repo view.
    return { ...project, repoPaths: fresh ?? [] };
  });

  // Project SQLite projects the ledger doesn't know about (e.g. created in the
  // Settings dialog) so the dashboard sees EVERY real project — not just the
  // ones the panel rail created. Without this, a Settings-curated project is
  // orphaned and the dashboard keeps showing a stale one.
  let colorIndex = projects.length;
  for (const sp of sqliteProjects) {
    if (representedSqliteProjectIds.has(sp.id)) continue;
    projects.push({
      id: sp.id,
      name: sp.name,
      repoPaths: pathsFor(sp),
      createdAt: new Date(sp.createdAt ?? Date.now()).toISOString(),
      color: PROJECT_COLOR_PALETTE[colorIndex % PROJECT_COLOR_PALETTE.length],
    });
    colorIndex += 1;
  }

  // Single-repo projection: any pool repo not in ANY project surfaces as its own
  // single-repo project so it's switchable and behaves as just that repo — until
  // more repos get added to it, which promotes it to a real multi-repo project.
  // These are virtual (id 'repo:<id>'); writeLedger never persists them.
  const assignedPaths = new Set(projects.flatMap((p) => p.repoPaths.map(normalizeRepoPath)));
  for (const repo of repos) {
    const repoPath = normalizeRepoPath(repo.localPath);
    if (assignedPaths.has(repoPath)) continue;
    projects.push({
      id: `repo:${repo.id}`,
      name: repo.name,
      repoPaths: [repoPath],
      createdAt: repo.addedAt ?? nowIso(),
      color: PROJECT_COLOR_PALETTE[colorIndex % PROJECT_COLOR_PALETTE.length],
    });
    colorIndex += 1;
  }

  return { ...ledger, projects };
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
    // Preserve the stored active id even if it isn't among the stored project
    // records — it may reference an appended SQLite project or a virtual
    // single-repo project. getProjectsLedger finalizes it against the projection.
    const activeProjectId = typeof parsed.activeProjectId === 'string' && parsed.activeProjectId
      ? parsed.activeProjectId
      : projects[0]!.id;
    // #1099 Phase 2 — same SQLite overlay as the async readRawLedger.
    return overlayLedgerWithSqliteMeta({ projects, activeProjectId });
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
  const activeProject = resolveActiveProject(ledger);
  const project = repoPath
    ? (repoPathBelongsToProject(activeProject, repoPath)
        ? activeProject
        : ledger.projects.find((candidate) => repoPathBelongsToProject(candidate, repoPath)) ?? activeProject)
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
  const activeProject = resolveActiveProject(ledger);
  const project = repoPath
    ? (repoPathBelongsToProject(activeProject, repoPath)
        ? activeProject
        : ledger.projects.find((candidate) => repoPathBelongsToProject(candidate, repoPath)) ?? activeProject)
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

function uniqueProjectSlugForName(name: string, projects: ProjectRecord[], ownerProjectId?: string): string {
  const base = projectNameToSlug(name);
  const used = new Set(
    projects
      .filter((project) => project.id !== ownerProjectId)
      .map((project) => projectNameToSlug(project.name)),
  );
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

export async function createProject(name: string): Promise<ProjectsLedger> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  if (trimmed.length > 60) throw new Error('Project name must be 60 characters or fewer.');
  // Create the project in SQLite (the source of truth). It surfaces in the
  // ledger via the projection in enrich(), so we DON'T add a separate ledger
  // record (that double-created it) — we just point the active project at it.
  const ledger = await getProjectsLedger();
  const slug = uniqueProjectSlugForName(trimmed, ledger.projects);
  const sqlite = createSqliteProject({ name: trimmed, slug, description: null });
  const next: ProjectsLedger = {
    ...ledger,
    activeProjectId: sqlite?.id ?? ledger.activeProjectId,
  };
  await writeLedger(next);
  return getProjectsLedger();
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
  const target = ledger.projects.find((p) => p.id === projectId);
  // Rename in SQLite too so the slug stays aligned (the ledger↔SQLite bridge).
  if (target) {
    const sqlite = resolveSqliteProject(target);
    if (sqlite) {
      updateSqliteProject(sqlite.id, {
        name: trimmed,
        slug: uniqueProjectSlugForName(trimmed, ledger.projects, projectId),
      });
    }
  }
  const next: ProjectsLedger = {
    ...ledger,
    projects: ledger.projects.map((p) => (p.id === projectId ? { ...p, name: trimmed } : p)),
  };
  await writeLedger(next);
  return getProjectsLedger();
}

export async function deleteProject(projectId: string): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  if (ledger.projects.length <= 1) {
    throw new Error('Cannot delete the only project.');
  }
  const target = ledger.projects.find((p) => p.id === projectId);

  // Delete removes the repos too (operator ruling 2026-07-09): a repo left in
  // the pool re-projects as a virtual single-repo row with the same name, so
  // the delete visibly "doesn't work". Repos on disk are never touched, and a
  // repo that another project still uses survives.
  if (projectId.startsWith('repo:')) {
    // Virtual single-repo projection — nothing is persisted for it, so the ONLY
    // real delete is removing the repo from the pool (the old filter-and-write
    // was a silent no-op: writeLedger drops repo:* ids and the projection
    // re-derived the row on every read).
    if (target) {
      const repoId = projectId.slice('repo:'.length);
      try {
        await removeRepoFromPool(repoId);
      } catch (error) {
        console.warn(`[projects] Failed to remove repo ${repoId} for virtual project delete:`, error);
      }
    }
    const remaining = ledger.projects.filter((p) => p.id !== projectId);
    const activeProjectId = ledger.activeProjectId === projectId ? remaining[0]!.id : ledger.activeProjectId;
    await writeLedger({ projects: remaining, activeProjectId });
    return getProjectsLedger();
  }

  // Delete the SQLite project (source of truth) so the projection stops re-adding
  // it — otherwise a deleted project resurrects on the next read. Resolve it
  // whether the caller passed a ledger id or a raw SQLite id: the Settings
  // dialog passes SQLite ids, and slug-bridged projects appear in the
  // projection under their LEDGER id.
  const sqlite = target ? resolveSqliteProject(target) : getSqliteProjectWithRepos(projectId);
  let ownedRepoIds: string[] = [];
  if (sqlite) {
    ownedRepoIds = sqlite.repos.map((link) => link.repoId);
    deleteSqliteProject(sqlite.id);
  }

  // Remove repos exclusive to the deleted project from the pool. Membership is
  // re-read AFTER the SQLite delete so a repo shared with any surviving project
  // is kept.
  if (ownedRepoIds.length > 0) {
    let stillUsed = new Set<string>();
    try {
      stillUsed = new Set(
        listSqliteProjects()
          // The synthetic `workspace` project is the unassigned-repo pool, not a
          // real user project — `syncProjectStoreFromPanelLedger` materializes it
          // from the default "Workspace" ledger row and links every loose repo to
          // it. Counting it as "still using" a repo made EVERY repo look shared,
          // so a deleted project never removed anything and its repos visibly
          // "went to the Workspace" (operator report, 0.1.580). Exclude it so a
          // repo whose only other home is the pool is still treated as exclusive.
          .filter((project) => project.slug !== 'workspace')
          .flatMap((project) => project.repos.map((link) => link.repoId)),
      );
    } catch {
      // If membership can't be read, err on the side of keeping repos.
      stillUsed = new Set(ownedRepoIds);
    }
    for (const repoId of ownedRepoIds) {
      if (stillUsed.has(repoId)) continue;
      try {
        await removeRepoFromPool(repoId);
      } catch (error) {
        console.warn(`[projects] Failed to remove repo ${repoId} while deleting project ${projectId}:`, error);
      }
    }
  }

  // Drop every identity the project is known by: the caller's id, the projected
  // ledger id, and the SQLite id (all can differ across the slug bridge).
  const removedIds = new Set<string>([projectId]);
  if (target) removedIds.add(target.id);
  if (sqlite) removedIds.add(sqlite.id);
  const remaining = ledger.projects.filter((p) => !removedIds.has(p.id));
  const activeProjectId = removedIds.has(ledger.activeProjectId)
    ? remaining[0]!.id
    : ledger.activeProjectId;
  await writeLedger({ projects: remaining, activeProjectId });
  return getProjectsLedger();
}

/**
 * Resolve the SQLite project for a ledger project (by id, else slug). The ledger
 * and SQLite use separate id namespaces bridged by slug, so try both.
 */
function resolveSqliteProject(ledgerProject: { id: string; name: string }) {
  return getSqliteProjectWithRepos(ledgerProject.id)
    ?? (() => {
      const bySlug = getSqliteProjectBySlug(projectNameToSlug(ledgerProject.name));
      return bySlug ? getSqliteProjectWithRepos(bySlug.id) : null;
    })();
}

/**
 * Reconcile the SQLite project (the membership source of truth) to exactly
 * `repoPaths`, creating it if it doesn't exist yet. This is what makes a
 * panel-rail membership edit (move/drag) actually stick instead of being
 * overwritten by the SQLite-derived ledger projection on the next read.
 */
export async function setProjectRepos(projectId: string, repoPaths: string[]): Promise<ProjectsLedger> {
  const ledger = await getProjectsLedger();
  const project = ledger.projects.find((p) => p.id === projectId);
  const normalized = Array.from(new Set(repoPaths.map(normalizeRepoPath)));
  if (project) {
    // Membership goes to SQLite (the source of truth). The ledger's repoPaths are
    // derived from SQLite via enrich, so re-read rather than persisting them here.
    await reconcileSqliteProjectRepos(project, normalized);
  }
  return getProjectsLedger();
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
