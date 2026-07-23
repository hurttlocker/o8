/**
 * Dispatch — Edge-case surfacer (#536).
 *
 * Given one or more target files, walks the outbound + inbound import graph
 * 1–2 hops out and extracts "edge-case sites" — conditional branches,
 * error handlers, reconciliation paths, archive/cleanup logic, and
 * early-exit loop conditions that a change to the target might silently
 * break.
 *
 * The v0 pass is purely pattern-based regex matching over the file
 * contents. A TS compiler API pass plus a cheap-model semantic summarizer
 * are both future enhancements — see the TODO markers below for the
 * plug-in points.
 *
 * Results are cached on disk keyed by file-content hash under
 * `${CORTEX_IDE_DATA_DIR}/cache/edge-case-sites/`. Cache misses re-scan
 * from the live file; cache hits skip disk I/O. Content hashes are taken
 * from the skeleton cache so invalidation happens automatically on the
 * next skeleton scan.
 *
 * Used by the dispatch pipeline to populate `packet.edgeCaseSites` which
 * the packet-prompt composer then renders as a "Watch for these" block.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAllCached, getCached, getImportGraph, getInboundImporters } from '@/lib/skeleton';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getDataDir } from '@/lib/data-dir-migration';

type EdgeCaseKind = NonNullable<NonNullable<OrchestratorPacket['edgeCaseSites']>[number]['kind']>;

export interface EdgeCaseSite {
  location: string;
  description: string;
  kind?: EdgeCaseKind;
}

export interface SurfaceEdgeCasesResult {
  sites: EdgeCaseSite[];
  /** Non-empty when the surfacer bailed — e.g. `'parse-failed'`, `'no-targets'`. */
  reason?: string;
}

// ── Cache layer ──

const CACHE_ROOT = join(
  getDataDir(),
  'cache',
  'edge-case-sites',
);

function ensureCacheDir() {
  try {
    if (!existsSync(CACHE_ROOT)) mkdirSync(CACHE_ROOT, { recursive: true });
  } catch {
    // Ignore — cache is best-effort. The surfacer returns live results when
    // the cache dir can't be created.
  }
}

function cacheKeyFor(repoPath: string, filePath: string, contentHash: string): string {
  const digest = createHash('sha256').update(`${repoPath}::${filePath}`).digest('hex').slice(0, 16);
  return `${digest}.${contentHash.slice(0, 12)}.json`;
}

interface CacheEntry {
  version: 1;
  repoPath: string;
  filePath: string;
  sites: EdgeCaseSite[];
  cachedAt: string;
}

function readCachedSites(cacheKey: string): EdgeCaseSite[] | null {
  try {
    const raw = readFileSync(join(CACHE_ROOT, cacheKey), 'utf-8');
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.version !== 1 || !Array.isArray(parsed.sites)) return null;
    return parsed.sites;
  } catch {
    return null;
  }
}

function writeCachedSites(cacheKey: string, entry: CacheEntry) {
  try {
    ensureCacheDir();
    writeFileSync(join(CACHE_ROOT, cacheKey), JSON.stringify(entry, null, 2), 'utf-8');
  } catch {
    // Best-effort cache writes — ignore failures.
  }
}

// ── Pattern-based extraction (v0) ──

interface PatternRule {
  pattern: RegExp;
  kind: EdgeCaseKind;
  /** Short description prefix rendered before the matched source line. */
  description: string;
}

/**
 * Lightweight pattern rules. Each matches a single line in the file and
 * emits an EdgeCaseSite tagged with the `kind` + a 1-line description.
 *
 * TODO(#536): swap this for a TypeScript compiler API walker that sees
 * actual AST nodes — ternary + if/else arms, catch clauses, break/continue,
 * early return statements, switch-default arms. That pass belongs in a
 * dedicated `ast-walker.ts` module so the surfacer can layer semantic
 * summaries on top.
 */
const PATTERN_RULES: PatternRule[] = [
  {
    pattern: /\b(try|catch)\s*\(/,
    kind: 'error-handler',
    description: 'Error-handler boundary — change must preserve rethrow / log semantics',
  },
  {
    pattern: /\bcatch\s*\(\s*\w*\s*\)/,
    kind: 'error-handler',
    description: 'catch clause — verify this still swallows / rethrows the right errors',
  },
  {
    pattern: /\breconcil(e|iation)\b/i,
    kind: 'reconciliation',
    description: 'Reconciliation path — state merge here might drift on packet replacement',
  },
  {
    pattern: /\barchive(d)?\b/i,
    kind: 'archive',
    description: 'Archive / cleanup path — check cascade ordering vs new flow',
  },
  {
    pattern: /\bcleanup\b/i,
    kind: 'archive',
    description: 'Cleanup path — ensure this still fires for the new code path',
  },
  {
    pattern: /\b(while|for|do)\s*\(/,
    kind: 'loop-exit',
    description: 'Loop — early-exit condition may skip sites the new change introduces',
  },
  {
    pattern: /\bbreak\s*;/,
    kind: 'loop-exit',
    description: 'Loop `break` — verify this still exits on the right condition',
  },
  {
    pattern: /\bcontinue\s*;/,
    kind: 'loop-exit',
    description: 'Loop `continue` — may skip new handling you intended to add',
  },
  {
    pattern: /\bif\s*\(.*\|\|.*\).*\breturn\b/,
    kind: 'conditional',
    description: 'Disjunctive early-return — change must honor all OR-ed exits',
  },
  {
    pattern: /\breturn\s+null\b/,
    kind: 'conditional',
    description: 'Early `return null` — caller depends on the null sentinel',
  },
  {
    pattern: /\bthrow\s+new\s+\w+/,
    kind: 'error-handler',
    description: 'Explicit throw — callers catch this and may need to catch new shapes',
  },
];

function scanFileForSites(
  repoPath: string,
  filePath: string,
): EdgeCaseSite[] {
  const absolutePath = join(repoPath, filePath);

  let content: string;
  try {
    content = readFileSync(absolutePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const sites: EdgeCaseSite[] = [];
  const seenLines = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip comments + blank lines so we don't surface doc blocks.
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    for (const rule of PATTERN_RULES) {
      if (rule.pattern.test(line) && !seenLines.has(i)) {
        seenLines.add(i);
        sites.push({
          location: `${filePath}:${i + 1}`,
          description: rule.description,
          kind: rule.kind,
        });
        break;
      }
    }

    // Cap per-file output so no single leaf file drowns the prompt.
    if (sites.length >= 4) break;
  }

  return sites;
}

// ── Public API ──

export interface SurfaceEdgeCasesInput {
  repoPath: string;
  targetFiles: string[];
  /** Depth-1 graph walks all direct outbound imports + direct inbound callers. */
  depth?: 1 | 2;
  /** Maximum distinct sites to return across the whole walk. */
  maxSites?: number;
}

/**
 * Walk the import graph outward + inward from the target files and extract
 * a capped set of edge-case sites. Never throws — on garbage input returns
 * `{ sites: [], reason: '…' }` so the caller can decide whether to render
 * the section at all.
 *
 * TODO(#536): once the pattern pass lands, wire a cheap-model semantic
 * summarizer here. Shape:
 *
 *   const summaries = await cheapModelSummarize(sites.map((s) => s.description));
 *   return sites.map((s, i) => ({ ...s, description: summaries[i] ?? s.description }));
 *
 * Cache key should combine the target file's contentHash + the semantic
 * model version so invalidations line up with both source changes and
 * prompt-engineering tweaks.
 */
export function surfaceEdgeCases(input: SurfaceEdgeCasesInput): SurfaceEdgeCasesResult {
  try {
    const { repoPath, depth = 1, maxSites = 12 } = input;

    const targets = Array.from(new Set(
      (input.targetFiles ?? [])
        .map((value) => (value ?? '').trim())
        .filter(Boolean),
    ));

    if (!repoPath || targets.length === 0) {
      return { sites: [], reason: 'no-targets' };
    }

    // Gather candidate files: outbound graph (what the target imports) +
    // inbound importers (callers that could break). Both are capped via
    // the final site slice so prompt size stays bounded.
    const candidates = new Set<string>();
    for (const target of targets) {
      const graph = getImportGraph(repoPath, target, depth);
      if (!graph.root) continue;

      for (const node of graph.nodes) {
        candidates.add(node.filePath);
      }

      for (const importer of getInboundImporters(repoPath, target)) {
        candidates.add(importer);
        if (candidates.size >= 24) break;
      }

      if (candidates.size >= 24) break;
    }

    // Fall back to the target files themselves when the graph is empty.
    // Weak models still benefit from seeing risk-sites in the file they
    // were explicitly told to modify.
    if (candidates.size === 0) {
      for (const target of targets) candidates.add(target);
    }

    const allSites: EdgeCaseSite[] = [];
    for (const candidate of candidates) {
      const cached = getCached(repoPath, candidate);
      if (!cached) continue;

      const cacheKey = cacheKeyFor(repoPath, candidate, cached.contentHash);
      const cachedSites = readCachedSites(cacheKey);
      if (cachedSites) {
        allSites.push(...cachedSites);
        if (allSites.length >= maxSites) break;
        continue;
      }

      const scanned = scanFileForSites(repoPath, candidate);
      writeCachedSites(cacheKey, {
        version: 1,
        repoPath,
        filePath: candidate,
        sites: scanned,
        cachedAt: new Date().toISOString(),
      });

      allSites.push(...scanned);
      if (allSites.length >= maxSites) break;
    }

    // Dedupe by location + description, then slice to cap.
    const seen = new Set<string>();
    const deduped: EdgeCaseSite[] = [];
    for (const site of allSites) {
      const key = `${site.location}::${site.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(site);
      if (deduped.length >= maxSites) break;
    }

    return { sites: deduped };
  } catch {
    // Surfacer must NEVER throw — dispatch pipeline will fall back to
    // legacy prompt when `edgeCaseSites` is undefined.
    return { sites: [], reason: 'parse-failed' };
  }
}

/**
 * Quickly probe whether the skeleton cache has anything useful for this
 * repo — lets the caller skip the whole surfacer when the cache is empty.
 */
export function skeletonCachePrimed(repoPath: string): boolean {
  try {
    return getAllCached(repoPath).length > 0;
  } catch {
    return false;
  }
}

// ── Prompt rendering ──

/**
 * Render edge-case sites as prompt sections — used by the packet-prompt
 * composer. Returns an empty array when there are no sites so the caller
 * doesn't need to guard.
 */
export function renderEdgeCaseSections(
  sites: OrchestratorPacket['edgeCaseSites'],
): string[] {
  if (!sites || sites.length === 0) return [];

  const sections: string[] = [
    'Watch for these affected sites (edge-case surfacer output):',
  ];

  const grouped = new Map<string, EdgeCaseSite[]>();
  for (const site of sites) {
    const bucket = site.kind ?? 'other';
    const list = grouped.get(bucket) ?? [];
    list.push(site);
    grouped.set(bucket, list);
  }

  const order: EdgeCaseKind[] = [
    'reconciliation',
    'error-handler',
    'archive',
    'conditional',
    'loop-exit',
    'other',
  ];

  for (const bucket of order) {
    const list = grouped.get(bucket);
    if (!list || list.length === 0) continue;
    sections.push(`- ${bucket}:`);
    for (const site of list.slice(0, 6)) {
      sections.push(`    - ${site.location} — ${site.description}`);
    }
    if (list.length > 6) {
      sections.push(`    - (+${list.length - 6} more)`);
    }
  }

  sections.push(
    'These are adjacent sites a change here might silently break. Confirm or explicitly set aside each before landing a write.',
  );

  return sections;
}
