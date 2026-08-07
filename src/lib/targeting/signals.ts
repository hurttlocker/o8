/**
 * Targeting Machine — signal collection.
 *
 * Gathers the cheap, PRE-COMPUTED per-file signals the scorer needs to triage a
 * repo ("where should the operator point their expensive agents?"). Everything
 * here is free + offline: it reads the skeleton cache (LOC, symbol count,
 * imports) + the one-pass inbound-importer centrality, and adds the only missing
 * signal — recent git churn — via a single `git log` pass (same execSync pattern
 * as skeleton/autoscan.ts).
 *
 * Signals only; NO scoring opinion (that's scorer.ts). Only skeleton-cached
 * files get a row — the cache is already capped at 2000 files.
 */

import { execSync } from 'node:child_process';

import { getAllCached } from '@/lib/skeleton/store';
import { getInboundImporterCounts } from '@/lib/skeleton/import-graph';
import type { FileSkeleton } from '@/lib/skeleton/types';

/** Raw, un-opinionated per-file signals. */
export interface TargetSignals {
  path: string;
  /** Lines of code (skeleton lineCount). */
  loc: number;
  /** Symbol count — a cheap complexity proxy. */
  symbolCount: number;
  /** Outbound imports — how many modules this file depends on. */
  outboundImports: number;
  /** Inbound importers — how many files depend on THIS one (centrality). */
  inbound: number;
  /** Commits touching this file within the churn window (recent-pain proxy). */
  churn: number;
}

export const DEFAULT_CHURN_WINDOW_DAYS = 30;

/**
 * Parse `git log --name-only --format=` output into a per-path commit tally.
 * PURE — the output is file paths (one per line) with blank separators between
 * commits; a path counts once per commit it appears in.
 */
export function parseGitChurn(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Recent git churn per path — a single `git log` pass over the last
 * `windowDays`. Returns an empty map on any git failure (non-repo, no history)
 * so the scorer degrades to a churn-free heuristic rather than crashing.
 */
export function computeGitChurn(repoPath: string, windowDays = DEFAULT_CHURN_WINDOW_DAYS): Map<string, number> {
  try {
    const output = execSync(
      `git -c core.quotepath=false log --since="${windowDays} days ago" --name-only --format= --no-renames 2>/dev/null`,
      { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
    );
    return parseGitChurn(output);
  } catch {
    return new Map();
  }
}

/**
 * Join the cached skeletons with centrality + churn into one signal row per
 * cached file. PURE — all inputs are passed in, so it's directly unit-testable.
 */
export function joinSignals(
  skeletons: FileSkeleton[],
  inbound: Map<string, number>,
  churn: Map<string, number>,
): TargetSignals[] {
  return skeletons.map((file) => ({
    path: file.relativePath,
    loc: file.lineCount,
    symbolCount: file.symbols.length,
    outboundImports: file.imports.length,
    inbound: inbound.get(file.relativePath) ?? 0,
    churn: churn.get(file.relativePath) ?? 0,
  }));
}

/**
 * Collect signals for every skeleton-cached file in the repo. Wires the cache
 * reads + the git-churn pass into `joinSignals`. Returns `[]` when the repo has
 * no skeleton cache yet.
 */
export function collectSignals(repoPath: string, windowDays = DEFAULT_CHURN_WINDOW_DAYS): TargetSignals[] {
  const skeletons = getAllCached(repoPath);
  if (skeletons.length === 0) return [];
  const inbound = getInboundImporterCounts(repoPath);
  const churn = computeGitChurn(repoPath, windowDays);
  return joinSignals(skeletons, inbound, churn);
}
