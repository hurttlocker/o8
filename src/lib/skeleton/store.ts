/**
 * Skeleton Map — SQLite cache layer.
 *
 * Separate database at ~/.o8/skeleton.db.
 * Disposable cache — can be deleted anytime with zero data loss.
 * Follows the same singleton + pragma pattern as src/lib/db/index.ts.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ChunkCacheRow, CodeChunk, FileChunks, FileSkeleton, SkeletonCacheRow, SkeletonSymbol, SymbolKind } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'skeleton.db');

// ── Singleton ──

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 3000');
  _db.pragma('cache_size = -5000'); // 5MB

  _db.exec(`
    CREATE TABLE IF NOT EXISTS skeleton_cache (
      repo_path    TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language     TEXT NOT NULL,
      symbols_json TEXT NOT NULL,
      imports_json TEXT NOT NULL,
      line_count   INTEGER NOT NULL,
      parsed_at    TEXT NOT NULL,
      PRIMARY KEY (repo_path, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_skeleton_repo ON skeleton_cache(repo_path);

    CREATE TABLE IF NOT EXISTS skeleton_chunks (
      repo_path    TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      symbol_name  TEXT NOT NULL,
      symbol_kind  TEXT NOT NULL,
      body         TEXT NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      start_pos    INTEGER NOT NULL,
      end_pos      INTEGER NOT NULL,
      token_count  INTEGER NOT NULL,
      exported     INTEGER NOT NULL DEFAULT 0,
      parent       TEXT,
      imports_json TEXT NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      parsed_at    TEXT NOT NULL,
      PRIMARY KEY (repo_path, file_path, symbol_name)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_repo ON skeleton_chunks(repo_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_kind ON skeleton_chunks(repo_path, symbol_kind);
  `);

  console.log(`[skeleton] Cache DB: ${DB_PATH}`);
  return _db;
}

// ── Cache operations ──

/**
 * Check if a cached entry exists and its hash matches the current file.
 */
export function isCacheValid(repoPath: string, filePath: string, currentHash: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT content_hash FROM skeleton_cache WHERE repo_path = ? AND file_path = ?',
  ).get(repoPath, filePath) as { content_hash: string } | undefined;
  return row?.content_hash === currentHash;
}

/**
 * Get a cached skeleton for a single file.
 */
export function getCached(repoPath: string, filePath: string): FileSkeleton | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM skeleton_cache WHERE repo_path = ? AND file_path = ?',
  ).get(repoPath, filePath) as SkeletonCacheRow | undefined;

  if (!row) return null;

  return {
    relativePath: row.file_path,
    language: row.language as FileSkeleton['language'],
    symbols: JSON.parse(row.symbols_json) as SkeletonSymbol[],
    imports: JSON.parse(row.imports_json) as string[],
    lineCount: row.line_count,
    contentHash: row.content_hash,
  };
}

/**
 * Get all cached skeletons for a repository.
 */
export function getAllCached(repoPath: string): FileSkeleton[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM skeleton_cache WHERE repo_path = ? ORDER BY file_path',
  ).all(repoPath) as SkeletonCacheRow[];

  return rows.map(row => ({
    relativePath: row.file_path,
    language: row.language as FileSkeleton['language'],
    symbols: JSON.parse(row.symbols_json) as SkeletonSymbol[],
    imports: JSON.parse(row.imports_json) as string[],
    lineCount: row.line_count,
    contentHash: row.content_hash,
  }));
}

/**
 * Insert or update a file skeleton in the cache.
 */
export function upsert(repoPath: string, skeleton: FileSkeleton): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO skeleton_cache (repo_path, file_path, content_hash, language, symbols_json, imports_json, line_count, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_path, file_path)
    DO UPDATE SET content_hash = excluded.content_hash,
                  language = excluded.language,
                  symbols_json = excluded.symbols_json,
                  imports_json = excluded.imports_json,
                  line_count = excluded.line_count,
                  parsed_at = excluded.parsed_at
  `).run(
    repoPath,
    skeleton.relativePath,
    skeleton.contentHash,
    skeleton.language,
    JSON.stringify(skeleton.symbols),
    JSON.stringify(skeleton.imports),
    skeleton.lineCount,
    new Date().toISOString(),
  );
}

/**
 * Batch upsert multiple skeletons in a single transaction.
 */
export function upsertBatch(repoPath: string, skeletons: FileSkeleton[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO skeleton_cache (repo_path, file_path, content_hash, language, symbols_json, imports_json, line_count, parsed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (repo_path, file_path)
    DO UPDATE SET content_hash = excluded.content_hash,
                  language = excluded.language,
                  symbols_json = excluded.symbols_json,
                  imports_json = excluded.imports_json,
                  line_count = excluded.line_count,
                  parsed_at = excluded.parsed_at
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const s of skeletons) {
      stmt.run(
        repoPath,
        s.relativePath,
        s.contentHash,
        s.language,
        JSON.stringify(s.symbols),
        JSON.stringify(s.imports),
        s.lineCount,
        now,
      );
    }
  });
  tx();
}

/**
 * Remove cache entries for files that no longer exist on disk.
 * Returns the number of pruned entries.
 */
export function pruneStale(repoPath: string, currentFiles: Set<string>): number {
  const db = getDb();
  const cached = db.prepare(
    'SELECT file_path FROM skeleton_cache WHERE repo_path = ?',
  ).all(repoPath) as Array<{ file_path: string }>;

  const toDelete = cached.filter(row => !currentFiles.has(row.file_path));
  if (toDelete.length === 0) return 0;

  const delStmt = db.prepare(
    'DELETE FROM skeleton_cache WHERE repo_path = ? AND file_path = ?',
  );
  const tx = db.transaction(() => {
    for (const row of toDelete) {
      delStmt.run(repoPath, row.file_path);
    }
  });
  tx();

  return toDelete.length;
}

/**
 * Wipe all cache for a repository.
 */
export function clearRepo(repoPath: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM skeleton_cache WHERE repo_path = ?').run(repoPath);
  db.prepare('DELETE FROM skeleton_chunks WHERE repo_path = ?').run(repoPath);
  return result.changes;
}

// ── Chunk cache operations ──

/**
 * Check if chunk cache is valid for a file (hash matches).
 */
export function isChunkCacheValid(repoPath: string, filePath: string, currentHash: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT content_hash FROM skeleton_chunks WHERE repo_path = ? AND file_path = ? LIMIT 1',
  ).get(repoPath, filePath) as { content_hash: string } | undefined;
  return row?.content_hash === currentHash;
}

/**
 * Upsert all chunks for a file in a single transaction.
 * Deletes existing chunks for the file first, then inserts new ones.
 */
export function upsertChunks(repoPath: string, fileChunks: FileChunks): void {
  const db = getDb();
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // Clear old chunks for this file
    db.prepare(
      'DELETE FROM skeleton_chunks WHERE repo_path = ? AND file_path = ?',
    ).run(repoPath, fileChunks.relativePath);

    // Insert new chunks
    const stmt = db.prepare(`
      INSERT INTO skeleton_chunks
        (repo_path, file_path, symbol_name, symbol_kind, body, start_line, end_line,
         start_pos, end_pos, token_count, exported, parent, imports_json, content_hash, parsed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of fileChunks.chunks) {
      stmt.run(
        repoPath,
        fileChunks.relativePath,
        c.symbolName,
        c.symbolKind,
        c.body,
        c.startLine,
        c.endLine,
        c.startPos,
        c.endPos,
        c.tokenCount,
        c.exported ? 1 : 0,
        c.parent ?? null,
        JSON.stringify(c.localImports),
        fileChunks.contentHash,
        now,
      );
    }
  });
  tx();
}

function rowToChunk(row: ChunkCacheRow): CodeChunk {
  return {
    symbolName: row.symbol_name,
    symbolKind: row.symbol_kind as SymbolKind,
    body: row.body,
    startLine: row.start_line,
    endLine: row.end_line,
    startPos: row.start_pos,
    endPos: row.end_pos,
    tokenCount: row.token_count,
    exported: row.exported === 1,
    parent: row.parent ?? undefined,
    localImports: JSON.parse(row.imports_json) as string[],
  };
}

/**
 * Get all chunks for a single file.
 */
export function getChunksForFile(repoPath: string, filePath: string): CodeChunk[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM skeleton_chunks WHERE repo_path = ? AND file_path = ? ORDER BY start_line',
  ).all(repoPath, filePath) as ChunkCacheRow[];
  return rows.map(rowToChunk);
}

/**
 * Get all chunks for a repo, grouped by file.
 */
export function getChunksForRepo(repoPath: string): FileChunks[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM skeleton_chunks WHERE repo_path = ? ORDER BY file_path, start_line',
  ).all(repoPath) as ChunkCacheRow[];

  const grouped = new Map<string, { chunks: CodeChunk[]; hash: string }>();
  for (const row of rows) {
    let entry = grouped.get(row.file_path);
    if (!entry) {
      entry = { chunks: [], hash: row.content_hash };
      grouped.set(row.file_path, entry);
    }
    entry.chunks.push(rowToChunk(row));
  }

  return [...grouped.entries()].map(([filePath, { chunks, hash }]) => ({
    relativePath: filePath,
    language: 'typescript' as const,
    chunks,
    contentHash: hash,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenCount, 0),
  }));
}

/**
 * Get chunk count and total tokens for a repo (stats only, no body data).
 */
export function getChunkStats(repoPath: string): { chunkCount: number; totalTokens: number; fileCount: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as chunk_count,
           COALESCE(SUM(token_count), 0) as total_tokens,
           COUNT(DISTINCT file_path) as file_count
    FROM skeleton_chunks WHERE repo_path = ?
  `).get(repoPath) as { chunk_count: number; total_tokens: number; file_count: number };
  return { chunkCount: row.chunk_count, totalTokens: row.total_tokens, fileCount: row.file_count };
}

/**
 * Prune chunk cache for files that no longer exist.
 */
export function pruneStaleChunks(repoPath: string, currentFiles: Set<string>): number {
  const db = getDb();
  const cached = db.prepare(
    'SELECT DISTINCT file_path FROM skeleton_chunks WHERE repo_path = ?',
  ).all(repoPath) as Array<{ file_path: string }>;

  const toDelete = cached.filter(row => !currentFiles.has(row.file_path));
  if (toDelete.length === 0) return 0;

  const delStmt = db.prepare(
    'DELETE FROM skeleton_chunks WHERE repo_path = ? AND file_path = ?',
  );
  const tx = db.transaction(() => {
    for (const row of toDelete) {
      delStmt.run(repoPath, row.file_path);
    }
  });
  tx();
  return toDelete.length;
}

// ── DB health ──

/**
 * Get the skeleton.db file size in bytes.
 */
export function getDbSizeBytes(): number {
  try {
    const { statSync } = require('node:fs') as typeof import('node:fs');
    return statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

/**
 * Compact the database (reclaim space after deletes).
 * SQLite VACUUM rewrites the DB file, freeing unused pages.
 */
export function vacuumDb(): void {
  const db = getDb();
  db.exec('VACUUM');
  console.log('[skeleton] Database vacuumed');
}

/**
 * List all repo paths that have cached data.
 */
export function listCachedRepos(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT repo_path FROM skeleton_cache UNION SELECT DISTINCT repo_path FROM skeleton_chunks',
  ).all() as Array<{ repo_path: string }>;
  return rows.map(r => r.repo_path);
}
