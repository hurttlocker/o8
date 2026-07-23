/**
 * Repo markdown ingestion (epic #915 path-to-70 phase 1.7 #3).
 *
 * Walks every repo registered in `~/.o8/repos.json` and upserts markdown
 * files into the `docs` table. The schema-v16 trigger keeps `docs_fts`
 * in sync automatically.
 *
 * What gets ingested:
 *   - Top-level files: CLAUDE.md, README.md, AGENTS.md, DESIGN.md, THEME.md,
 *     plus any `*.md` at the repo root (catches CHANGELOG.md, LICENSE.md, etc.)
 *   - `docs/**\/*.md` recursively
 *
 * What gets skipped:
 *   - node_modules / .next / dist / build / target / .git directories
 *   - .claude/worktrees/** (agent worktrees create real branches and would
 *     pollute the index with duplicates of the parent repo's markdown)
 *
 * Body cap: 50KB per doc — most files are far smaller, but CLAUDE.md sometimes
 * accumulates well past that. Truncated bodies get a `[truncated at 50KB]`
 * suffix so retrievers know they're seeing a partial.
 */

import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { isFts5Available } from '@/lib/db/v14-fts5-migration';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 50 * 1024; // 50KB
const TRUNCATION_SUFFIX = '\n\n[truncated at 50KB]';

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'out',
  'target',
  '.git',
  // .claude/worktrees gets its own check (nested) below.
]);

const TOP_LEVEL_NAMED_FILES = new Set([
  'CLAUDE.md',
  'README.md',
  'AGENTS.md',
  'DESIGN.md',
  'THEME.md',
]);

export type DocKind =
  | 'readme'
  | 'claude_md'
  | 'agents_md'
  | 'design_md'
  | 'theme_md'
  | 'docs_md'
  | 'other_md';

export interface DocRow {
  id: string;
  repoPath: string;
  repoName: string;
  relPath: string;
  kind: DocKind;
  title: string;
  body: string;
  sizeBytes: number;
  lastModified: string;
  lastSynced: string;
}

interface RegisteredRepo {
  name: string;
  localPath: string;
}

interface IngestRepoResult {
  repoName: string;
  repoPath: string;
  scanned: number;
  upserted: number;
  unchanged: number;
  skipped: number;
  errors: string[];
}

export interface IngestSummary {
  repos: IngestRepoResult[];
  totalUpserted: number;
  totalUnchanged: number;
  byKind: Record<DocKind, number>;
}

// ── Repo registry ─────────────────────────────────────────────────────────────

/**
 * Read `~/.o8/repos.json` and return a list of `{ name, localPath }`. Both
 * legacy `path` and new `localPath` keys are accepted to match the rest of
 * the codebase. Empty array if the file is missing — the ingest job no-ops
 * cleanly on a fresh install.
 */
export function readRegisteredRepos(): RegisteredRepo[] {
  const dataDir = getDataDir();
  const registryPath = path.join(dataDir, 'repos.json');
  if (!existsSync(registryPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { repos?: unknown }).repos)
      ? (parsed as { repos: unknown[] }).repos
      : [];

  const out: RegisteredRepo[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const localPath = typeof record.localPath === 'string'
      ? record.localPath
      : typeof record.path === 'string'
        ? record.path
        : null;
    if (!localPath) continue;
    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name
      : path.basename(localPath);
    out.push({ name, localPath: path.resolve(localPath) });
  }
  return out;
}

// ── Walking + classification ──────────────────────────────────────────────────

/** Map `<rel_path>` → DocKind. */
function classifyKind(relPath: string): DocKind {
  const base = path.basename(relPath);
  // Top-level / well-known names first.
  if (base === 'CLAUDE.md') return 'claude_md';
  if (base === 'README.md' || base.toLowerCase() === 'readme.md') return 'readme';
  if (base === 'AGENTS.md') return 'agents_md';
  if (base === 'DESIGN.md') return 'design_md';
  if (base === 'THEME.md') return 'theme_md';
  // docs/** wins over generic *.md.
  const segments = relPath.split(path.sep);
  if (segments[0] === 'docs') return 'docs_md';
  return 'other_md';
}

/** First H1 (`# heading`) in the body, falling back to the file basename. */
function extractTitle(body: string, relPath: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].slice(0, 200);
  }
  return path.basename(relPath, path.extname(relPath));
}

/**
 * Walk a single repo and yield `{ relPath, absPath }` pairs for every
 * markdown file that matches the ingest rules. Cheap recursive readdir —
 * we don't shell out to `find` because Tauri/Node bundles can run on
 * machines without it.
 */
function* walkRepo(repoPath: string): Generator<{ relPath: string; absPath: string }> {
  // Top-level pass: any `*.md` lives at the root, plus `docs/` subtree.
  let topEntries: string[];
  try {
    topEntries = readdirSync(repoPath);
  } catch {
    return;
  }

  for (const name of topEntries) {
    const abs = path.join(repoPath, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Drop into `docs/` recursively. Other top-level dirs are skipped.
      if (name === 'docs') {
        yield* walkDocsRecursive(repoPath, abs);
      }
      continue;
    }

    if (!stat.isFile()) continue;
    if (!isMarkdown(name)) continue;
    // Top-level: include named files always, plus any `*.md` (CHANGELOG, NOTES, etc.).
    if (TOP_LEVEL_NAMED_FILES.has(name) || isMarkdown(name)) {
      yield { relPath: name, absPath: abs };
    }
  }
}

function* walkDocsRecursive(
  repoRoot: string,
  dirAbs: string,
): Generator<{ relPath: string; absPath: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }

  for (const name of entries) {
    if (SKIP_DIRECTORIES.has(name)) continue;
    const abs = path.join(dirAbs, name);

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Defensive against agent worktrees nested in docs/.
      if (isClaudeWorktreesDir(abs)) continue;
      yield* walkDocsRecursive(repoRoot, abs);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!isMarkdown(name)) continue;

    const relPath = path.relative(repoRoot, abs);
    yield { relPath, absPath: abs };
  }
}

function isMarkdown(name: string): boolean {
  return /\.md$/i.test(name);
}

/** True for `<repo>/.claude/worktrees`. */
function isClaudeWorktreesDir(absPath: string): boolean {
  const segments = absPath.split(path.sep);
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i] === '.claude' && segments[i + 1] === 'worktrees') return true;
  }
  return false;
}

// ── Body normalization ────────────────────────────────────────────────────────

function normalizeBody(raw: string): string {
  // Most repos store CRLF on Windows; normalize before truncation so the
  // 50KB cap counts characters consistently.
  const text = raw.replace(/\r\n/g, '\n');
  if (text.length <= MAX_BODY_BYTES) return text;
  return text.slice(0, MAX_BODY_BYTES) + TRUNCATION_SUFFIX;
}

// ── Persistence ───────────────────────────────────────────────────────────────

interface ExistingDocRow {
  id: string;
  last_modified: string;
  size_bytes: number;
}

/**
 * Upsert one repo's worth of markdown. Returns counts so the caller can
 * print a per-repo summary.
 *
 * Skip semantics: if the file's mtime + size match what's already in the
 * `docs` table, we don't re-read or re-upsert. Cheap incremental refresh.
 */
export function ingestRepo(repo: RegisteredRepo): IngestRepoResult {
  const result: IngestRepoResult = {
    repoName: repo.name,
    repoPath: repo.localPath,
    scanned: 0,
    upserted: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
  };

  if (!existsSync(repo.localPath)) {
    result.errors.push(`repo path missing: ${repo.localPath}`);
    return result;
  }

  const sqlite = getSqlite();
  if (!isFts5Available(sqlite)) {
    result.errors.push('FTS5 unavailable — docs table may exist but docs_fts will be empty');
  }

  // Index existing rows for cheap mtime-based skip.
  const existingRows = sqlite
    .prepare('SELECT id, last_modified, size_bytes FROM docs WHERE repo_path = ?')
    .all(repo.localPath) as ExistingDocRow[];
  const existingById = new Map(existingRows.map((r) => [r.id, r]));

  const upsertStmt = sqlite.prepare(
    `INSERT INTO docs
       (id, repo_path, repo_name, rel_path, kind, title, body, size_bytes, last_modified, last_synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       repo_name = excluded.repo_name,
       rel_path = excluded.rel_path,
       kind = excluded.kind,
       title = excluded.title,
       body = excluded.body,
       size_bytes = excluded.size_bytes,
       last_modified = excluded.last_modified,
       last_synced = excluded.last_synced`,
  );

  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // Wrap the file walk in a transaction — bulk inserts on first ingest are
  // ~10x faster, and incremental no-op runs still succeed.
  sqlite.transaction(() => {
    for (const { relPath, absPath } of walkRepo(repo.localPath)) {
      result.scanned += 1;
      const id = `${repo.localPath}:${relPath}`;
      seenIds.add(id);

      let stat;
      try {
        stat = statSync(absPath);
      } catch (err) {
        result.skipped += 1;
        result.errors.push(`stat ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const lastModified = stat.mtime.toISOString();
      const existing = existingById.get(id);
      if (existing && existing.last_modified === lastModified && existing.size_bytes === stat.size) {
        // Update last_synced only when the file is unchanged — keeps freshness
        // tracking honest without re-reading the body.
        sqlite.prepare('UPDATE docs SET last_synced = ? WHERE id = ?').run(now, id);
        result.unchanged += 1;
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(absPath, 'utf-8');
      } catch (err) {
        result.skipped += 1;
        result.errors.push(`read ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const body = normalizeBody(raw);
      const kind = classifyKind(relPath);
      const title = extractTitle(body, relPath);

      upsertStmt.run(
        id,
        repo.localPath,
        repo.name,
        relPath,
        kind,
        title,
        body,
        stat.size,
        lastModified,
        now,
      );
      result.upserted += 1;
    }

    // Optional: prune docs whose source file no longer exists. We keep this
    // conservative — only delete rows the walk should have hit (same repo
    // path, scoped to expected paths).
    if (existingById.size > 0) {
      const toDelete: string[] = [];
      for (const id of existingById.keys()) {
        if (!seenIds.has(id)) toDelete.push(id);
      }
      if (toDelete.length > 0) {
        const del = sqlite.prepare('DELETE FROM docs WHERE id = ?');
        for (const id of toDelete) {
          del.run(id);
        }
      }
    }
  })();

  return result;
}

/**
 * Walk every registered repo and ingest. Top-level entrypoint for the cron
 * / setup job. Emits a structured summary the CLI can pretty-print.
 */
export function ingestAllRepos(): IngestSummary {
  const repos = readRegisteredRepos();
  const summary: IngestSummary = {
    repos: [],
    totalUpserted: 0,
    totalUnchanged: 0,
    byKind: {
      readme: 0,
      claude_md: 0,
      agents_md: 0,
      design_md: 0,
      theme_md: 0,
      docs_md: 0,
      other_md: 0,
    },
  };

  for (const repo of repos) {
    const res = ingestRepo(repo);
    summary.repos.push(res);
    summary.totalUpserted += res.upserted;
    summary.totalUnchanged += res.unchanged;
  }

  // After ingest, gather per-kind counts from the live table for the report.
  try {
    const sqlite = getSqlite();
    const rows = sqlite
      .prepare('SELECT kind, COUNT(*) AS c FROM docs GROUP BY kind')
      .all() as Array<{ kind: DocKind; c: number }>;
    for (const r of rows) {
      if (r.kind in summary.byKind) {
        summary.byKind[r.kind] = r.c;
      }
    }
  } catch {
    // best-effort
  }

  return summary;
}
