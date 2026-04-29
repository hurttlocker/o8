/**
 * #899 — Fingerprint cache.
 *
 * Reads/writes one JSON file per repo at
 * `~/.o8/repo-fingerprints/<repo-id>.json`. On read we recompute the
 * current fingerprint and only short-circuit when the content hash matches
 * the cached value — so README, manifest, or deploy-config edits invalidate
 * automatically without a separate watcher.
 *
 * No throwing: every file/IO error degrades to "no cache, just recompute".
 */

import 'server-only';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { listRepos } from '@/lib/repos/registry';
import {
  computeFingerprint,
  type GithubMeta,
  type RepoFingerprint,
} from './fingerprint';

const CACHE_DIR_NAME = 'repo-fingerprints';

function cacheDir(): string {
  return join(getDataDir(), CACHE_DIR_NAME);
}

function cacheFilePath(repoId: string): string {
  return join(cacheDir(), `${sanitizeId(repoId)}.json`);
}

/**
 * Repo IDs come from `randomUUID()` so they're already filesystem-safe, but
 * a defensive scrub means a malformed ID can never escape the cache dir.
 */
function sanitizeId(repoId: string): string {
  return repoId.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64) || '_unknown';
}

function readCached(repoId: string): RepoFingerprint | null {
  const path = cacheFilePath(repoId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RepoFingerprint>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.hash !== 'string') return null;
    return parsed as RepoFingerprint;
  } catch {
    return null;
  }
}

function writeCached(repoId: string, fp: RepoFingerprint): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFilePath(repoId), JSON.stringify(fp, null, 2), 'utf-8');
  } catch (err) {
    console.warn(
      '[fingerprint-cache] Failed to write cache:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolve a repo path for a given id via the registry. Returns null when
 * the id isn't registered — callers should treat that as "no fingerprint".
 */
async function resolveRepoPath(repoId: string): Promise<string | null> {
  try {
    const repos = await listRepos();
    const entry = repos.find((r) => r.id === repoId);
    return entry?.localPath ?? null;
  } catch {
    return null;
  }
}

/**
 * Public entry point. Recomputes the fingerprint from disk; if the new
 * hash matches the cached one, returns the cached object (preserves the
 * original `generatedAt`). Otherwise writes the new one and returns it.
 *
 * Optional `github` lets callers pipe in metadata they already fetched
 * (description / topics / languages). When omitted those fields stay empty —
 * Stage 2 (the LLM call) is responsible for making the most of whatever
 * Stage 1 happens to have.
 */
export async function getOrComputeFingerprint(
  repoId: string,
  github?: GithubMeta,
): Promise<RepoFingerprint> {
  const repoPath = await resolveRepoPath(repoId);
  const fresh = computeFingerprint(repoId, repoPath ?? '', github);
  const cached = readCached(repoId);
  if (cached && cached.hash === fresh.hash) {
    return cached;
  }
  writeCached(repoId, fresh);
  return fresh;
}

/**
 * Direct path variant — useful for smoke tests that target an unregistered
 * folder (and for the smoke script that covers the "empty repo skeleton"
 * acceptance case). Bypasses the registry lookup.
 */
export function getOrComputeFingerprintForPath(
  repoId: string,
  repoPath: string,
  github?: GithubMeta,
): RepoFingerprint {
  const fresh = computeFingerprint(repoId, repoPath, github);
  const cached = readCached(repoId);
  if (cached && cached.hash === fresh.hash) {
    return cached;
  }
  writeCached(repoId, fresh);
  return fresh;
}

export function getFingerprintCacheDir(): string {
  return cacheDir();
}
