/**
 * Skeleton Map — Public API.
 *
 * Orchestrates: walk → hash → cache check → parse → assemble → render.
 */

import { basename } from 'node:path';
import { hashFile } from './parser';
import { parseFile } from './parser';
import { renderSkeleton } from './renderer';
import { getAllCached, getChunkStats, isCacheValid, isChunkCacheValid, pruneStale, pruneStaleChunks, upsertBatch, upsertChunks } from './store';
import { walkRepo } from './walker';
import type { FileSkeleton, RenderOptions, RenderedSkeleton, ScanOptions, SkeletonMap } from './types';

// ── In-memory render cache (avoid re-rendering on every LLM call) ──

interface RenderCacheEntry {
  rendered: RenderedSkeleton;
  repoPath: string;
  fileCount: number;
  cachedAt: number;
}

const renderCache = new Map<string, RenderCacheEntry>();
const RENDER_CACHE_TTL_MS = 60_000; // 1 minute

function renderCacheKey(repoPath: string, options: RenderOptions): string {
  return `${repoPath}:${options.maxTokens ?? 5000}:${(options.focusPaths ?? []).join(',')}`;
}

/**
 * Scan a repository: walk files, hash, parse (with cache), assemble map.
 * Returns the complete SkeletonMap.
 */
export async function scanRepo(options: ScanOptions): Promise<SkeletonMap> {
  const { repoPath } = options;
  const enableChunks = options.chunks !== false;
  const startMs = Date.now();

  console.log(`[skeleton] Scanning ${repoPath}...`);

  // Walk the repo
  const walkedFiles = walkRepo(options);
  const currentFiles = new Set(walkedFiles.map(f => f.relativePath));

  // Prune stale cache entries (deleted files)
  const pruned = pruneStale(repoPath, currentFiles);
  if (pruned > 0) {
    console.log(`[skeleton] Pruned ${pruned} stale cache entries`);
  }
  if (enableChunks) {
    pruneStaleChunks(repoPath, currentFiles);
  }

  // Hash all files and determine which need parsing/chunking
  const toParse: typeof walkedFiles = [];
  const toChunk: Array<{ absolutePath: string; relativePath: string; language: typeof walkedFiles[0]['language']; hash: string }> = [];
  const fileHashes = new Map<string, string>();

  for (const wf of walkedFiles) {
    let hash: string;
    try {
      hash = hashFile(wf.absolutePath);
    } catch {
      continue;
    }
    fileHashes.set(wf.relativePath, hash);

    if (!isCacheValid(repoPath, wf.relativePath, hash)) {
      toParse.push(wf);
    }

    // Check chunk cache separately (file might have signature cache but not chunks)
    if (enableChunks && (wf.language === 'typescript' || wf.language === 'tsx')) {
      if (!isChunkCacheValid(repoPath, wf.relativePath, hash)) {
        toChunk.push({ ...wf, hash });
      }
    }
  }

  // Parse uncached files (signatures — regex)
  const newSkeletons: FileSkeleton[] = [];
  for (const wf of toParse) {
    try {
      const skeleton = parseFile(wf.absolutePath, wf.relativePath, wf.language);
      newSkeletons.push(skeleton);
    } catch (err) {
      console.warn(`[skeleton] Failed to parse ${wf.relativePath}:`, err);
    }
  }

  if (newSkeletons.length > 0) {
    upsertBatch(repoPath, newSkeletons);
  }

  // Chunk uncached TS/TSX files (bodies — TS Compiler API)
  if (enableChunks && toChunk.length > 0) {
    try {
      await import('./chunker');
      // Warmup TS compiler on first chunk
      if (toChunk.length > 0) {
        const { warmup } = await import('./chunker');
        await warmup();
      }

      for (const wf of toChunk) {
        try {
          const { chunkFile } = await import('./chunker');
          const fileChunks = chunkFile(wf.absolutePath, wf.relativePath, wf.language);
          if (fileChunks && fileChunks.chunks.length > 0) {
            upsertChunks(repoPath, fileChunks);
          }
        } catch (err) {
          console.warn(`[skeleton] Failed to chunk ${wf.relativePath}:`, err);
        }
      }
    } catch {
      console.warn('[skeleton] Chunker not available — skipping AST chunking');
    }
  }

  // Load all cached skeletons (including newly parsed ones)
  const allSkeletons = getAllCached(repoPath);

  const scanDurationMs = Date.now() - startMs;
  const totalSymbols = allSkeletons.reduce((sum, f) => sum + f.symbols.length, 0);
  const totalLines = allSkeletons.reduce((sum, f) => sum + f.lineCount, 0);
  const chunkStats = enableChunks ? getChunkStats(repoPath) : null;

  const chunkLog = chunkStats ? `, ${chunkStats.chunkCount} chunks (${toChunk.length} chunked)` : '';
  console.log(`[skeleton] Scan complete: ${allSkeletons.length} files, ${totalSymbols} symbols, ${toParse.length} parsed, ${walkedFiles.length - toParse.length} cached${chunkLog} (${scanDurationMs}ms)`);

  // Invalidate render cache for this repo
  for (const [key] of renderCache) {
    if (key.startsWith(repoPath)) {
      renderCache.delete(key);
    }
  }

  return {
    repoPath,
    repoName: basename(repoPath),
    files: allSkeletons,
    totalFiles: allSkeletons.length,
    totalSymbols,
    totalLines,
    generatedAt: new Date().toISOString(),
    scanDurationMs,
  };
}

/**
 * Get the rendered skeleton for a repo, using in-memory cache.
 * Returns null if no skeleton cache exists (scan hasn't run yet).
 *
 * This is the primary integration point for context injection.
 */
export function getRenderedSkeletonCached(repoPath: string, options: RenderOptions = {}): RenderedSkeleton | null {
  const key = renderCacheKey(repoPath, options);

  // Check render cache
  const cached = renderCache.get(key);
  if (cached && Date.now() - cached.cachedAt < RENDER_CACHE_TTL_MS) {
    return cached.rendered;
  }

  // Load from SQLite cache
  const skeletons = getAllCached(repoPath);
  if (skeletons.length === 0) return null;

  const totalSymbols = skeletons.reduce((sum, f) => sum + f.symbols.length, 0);
  const totalLines = skeletons.reduce((sum, f) => sum + f.lineCount, 0);

  const map: SkeletonMap = {
    repoPath,
    repoName: basename(repoPath),
    files: skeletons,
    totalFiles: skeletons.length,
    totalSymbols,
    totalLines,
    generatedAt: new Date().toISOString(),
    scanDurationMs: 0,
  };

  const rendered = renderSkeleton(map, options);

  // Cache the render
  renderCache.set(key, {
    rendered,
    repoPath,
    fileCount: skeletons.length,
    cachedAt: Date.now(),
  });

  return rendered;
}

/**
 * Search symbols across cached skeletons for a repo.
 * Fuzzy-matches query against symbol names.
 */
export function searchSymbols(
  repoPath: string,
  query: string,
  limit: number = 10,
): Array<{ symbol: FileSkeleton['symbols'][0]; filePath: string; score: number }> {
  const skeletons = getAllCached(repoPath);
  const lowerQuery = query.toLowerCase();
  const results: Array<{ symbol: FileSkeleton['symbols'][0]; filePath: string; score: number }> = [];

  for (const file of skeletons) {
    for (const sym of file.symbols) {
      const lowerName = sym.name.toLowerCase();

      // Exact match
      if (lowerName === lowerQuery) {
        results.push({ symbol: sym, filePath: file.relativePath, score: 1.0 });
        continue;
      }

      // Prefix match
      if (lowerName.startsWith(lowerQuery)) {
        results.push({ symbol: sym, filePath: file.relativePath, score: 0.8 });
        continue;
      }

      // Contains match
      if (lowerName.includes(lowerQuery)) {
        results.push({ symbol: sym, filePath: file.relativePath, score: 0.6 });
        continue;
      }

      // Signature contains match (lower priority)
      if (sym.signature.toLowerCase().includes(lowerQuery)) {
        results.push({ symbol: sym, filePath: file.relativePath, score: 0.4 });
      }
    }
  }

  // Sort by score descending, then by exported status
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.symbol.exported ? 1 : 0) - (a.symbol.exported ? 1 : 0);
  });

  return results.slice(0, limit);
}

// Re-exports
export { renderSkeleton } from './renderer';
export { walkRepo } from './walker';
export { parseFile, hashFile, hashContent } from './parser';
export { clearRepo, getAllCached, getCached, getChunksForFile, getChunksForRepo, getChunkStats } from './store';
export { getImportGraph, getInboundImporters } from './import-graph';
export type { ImportGraphNode, ImportGraphResult } from './import-graph';
export {
  ensureBooted,
  triggerScan,
  triggerScanIfStale,
  startChangePolling,
  stopChangePolling,
} from './autoscan';
export type {
  CodeChunk,
  FileChunks,
  FileSkeleton,
  SkeletonMap,
  SkeletonSymbol,
  RenderedSkeleton,
  ScanOptions,
  RenderOptions,
} from './types';
