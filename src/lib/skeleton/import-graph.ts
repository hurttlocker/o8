/**
 * Skeleton Map — Import graph traversal.
 *
 * Given a target file path, walks the cached skeleton's `imports` list one or
 * two hops out to surface adjacent files a packet will likely need to read.
 *
 * Resolution strategy (cheap, best-effort):
 *   1. `@/foo/bar` aliases map to `src/foo/bar`
 *   2. Relative paths (`./bar`, `../baz`) resolve against the target file's dir
 *   3. Bare npm specifiers (no `/` or starting with a scoped `@org/`) are skipped
 *   4. A candidate path is considered resolved when a cached skeleton exists
 *      for `candidate.ts`, `candidate.tsx`, `candidate/index.ts`, or
 *      `candidate/index.tsx` in the skeleton cache
 *
 * Used by the dispatch pipeline to populate `packet.readBudget.requiredReads`
 * so weaker models see the relevant surface before writing (#535).
 */

import { dirname, normalize, posix } from 'node:path';
import { getAllCached, getCached } from './store';
import type { FileSkeleton } from './types';

const TS_CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Path-alias prefixes we know about. Keeps us from needing tsconfig parsing. */
const PATH_ALIAS_MAP: Array<{ prefix: string; replacement: string }> = [
  { prefix: '@/', replacement: 'src/' },
];

function stripExtension(filePath: string): string {
  return filePath.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');
}

function normalizeRelativePath(rawPath: string): string {
  return posix.normalize(rawPath).replace(/^\.\//, '');
}

/**
 * Try to resolve an import specifier to a cached-skeleton relative path.
 * Returns null when the specifier points to an npm package, a non-source
 * asset, or a file not tracked by the skeleton scanner.
 */
function resolveImportSpecifier(
  repoPath: string,
  sourceFileRelative: string,
  specifier: string,
): string | null {
  const trimmed = specifier.trim();
  if (!trimmed) return null;

  // Skip npm packages — bare specifiers (`react`, `next/server`,
  // `@anthropic-ai/sdk`) never point to tracked source files.
  const isAlias = PATH_ALIAS_MAP.some(({ prefix }) => trimmed.startsWith(prefix));
  const isRelative = trimmed.startsWith('./') || trimmed.startsWith('../');
  if (!isAlias && !isRelative) {
    return null;
  }

  // Resolve alias → repo-relative base path
  let basePath: string;
  if (isAlias) {
    const match = PATH_ALIAS_MAP.find(({ prefix }) => trimmed.startsWith(prefix));
    if (!match) return null;
    basePath = match.replacement + trimmed.slice(match.prefix.length);
  } else {
    const sourceDir = dirname(sourceFileRelative);
    basePath = normalize(`${sourceDir}/${trimmed}`);
  }

  const candidate = normalizeRelativePath(basePath);

  // Already pointing at a .ts/.tsx?
  if (/\.(ts|tsx|json|md)$/.test(candidate)) {
    const existing = getCached(repoPath, candidate);
    return existing ? existing.relativePath : null;
  }

  // Try each .ts/.tsx/index.ts suffix
  for (const suffix of TS_CANDIDATE_SUFFIXES) {
    const attempt = `${candidate}${suffix}`;
    const existing = getCached(repoPath, attempt);
    if (existing) return existing.relativePath;
  }

  return null;
}

export interface ImportGraphNode {
  filePath: string;
  depth: number;
  /** The direct parent that pulled this file in. */
  via: string | null;
}

export interface ImportGraphResult {
  /** The node the caller asked about (always depth 0). */
  root: ImportGraphNode | null;
  /**
   * All resolved nodes excluding the root, sorted breadth-first then
   * alphabetically. Each appears at most once.
   */
  nodes: ImportGraphNode[];
}

/**
 * Walk the import graph starting at `filePath`.
 *
 * `depth = 1` — direct imports only (the #535 default for weaker models).
 * `depth = 2` — direct imports plus their direct imports (used by the
 * edge-case surfacer, #536).
 *
 * Resolution is best-effort: unresolved specifiers (npm packages, aliased
 * paths that don't match our map, files outside the skeleton cache) are
 * dropped silently. This is intentional — we're building a hint, not a
 * strict dependency manifest.
 */
export function getImportGraph(
  repoPath: string,
  filePath: string,
  depth: 1 | 2 = 1,
): ImportGraphResult {
  const root = getCached(repoPath, filePath);
  if (!root) {
    return {
      root: null,
      nodes: [],
    };
  }

  const visited = new Set<string>([filePath]);
  const queue: Array<{ file: FileSkeleton; depth: number; via: string | null }> = [
    { file: root, depth: 0, via: null },
  ];
  const nodes: ImportGraphNode[] = [];

  while (queue.length > 0) {
    const entry = queue.shift()!;

    if (entry.depth > 0) {
      nodes.push({
        filePath: entry.file.relativePath,
        depth: entry.depth,
        via: entry.via,
      });
    }

    if (entry.depth >= depth) continue;

    for (const specifier of entry.file.imports) {
      const resolved = resolveImportSpecifier(
        repoPath,
        entry.file.relativePath,
        specifier,
      );
      if (!resolved || visited.has(resolved)) continue;
      visited.add(resolved);

      const childSkeleton = getCached(repoPath, resolved);
      if (!childSkeleton) continue;
      queue.push({
        file: childSkeleton,
        depth: entry.depth + 1,
        via: entry.file.relativePath,
      });
    }
  }

  // Stable ordering: depth first, then alphabetical by path so prompt output
  // is deterministic regardless of file-system walk order.
  nodes.sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.filePath.localeCompare(right.filePath);
  });

  return {
    root: {
      filePath: root.relativePath,
      depth: 0,
      via: null,
    },
    nodes,
  };
}

/**
 * Find all cached files that import the target. Useful for the edge-case
 * surfacer (#536) — it walks the INBOUND fan-out to find callers that could
 * break when the target changes.
 */
export function getInboundImporters(
  repoPath: string,
  filePath: string,
): string[] {
  const stripped = stripExtension(filePath);
  const all = getAllCached(repoPath);
  const importers: string[] = [];

  for (const file of all) {
    if (file.relativePath === filePath) continue;
    for (const specifier of file.imports) {
      const resolved = resolveImportSpecifier(repoPath, file.relativePath, specifier);
      if (resolved === filePath || (resolved && stripExtension(resolved) === stripped)) {
        importers.push(file.relativePath);
        break;
      }
    }
  }

  importers.sort();
  return importers;
}
