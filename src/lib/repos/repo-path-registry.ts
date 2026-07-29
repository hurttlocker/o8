import 'server-only';

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const REPO_REGISTRY_DISPLAY_PATH = '~/.o8/repos.json';
const REPO_REGISTRY_PATH = path.join(getDataDir(), 'repos.json');

export interface RegisteredRepoPathEntry extends Record<string, unknown> {
  path: string;
}

type RepoRegistryReadResult =
  | { ok: true; repos: RegisteredRepoPathEntry[] }
  | { ok: false; message: string };

export type RepoRegistryResolveResult =
  | { ok: true; repo: RegisteredRepoPathEntry; repoRoot: string }
  | { ok: false; message: string; status: number };

function unreadableRegistryResult(): RepoRegistryReadResult {
  return {
    ok: false,
    message: `Repository registry is unreadable. Check ${REPO_REGISTRY_DISPLAY_PATH}.`,
  };
}

function normalizeRepoPath(inputPath: string) {
  const expanded = inputPath.trim().replace(/^~(?=\/|$)/, os.homedir());
  return path.resolve(expanded);
}

function extractRepoEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (
    parsed
    && typeof parsed === 'object'
    && Array.isArray((parsed as { repos?: unknown }).repos)
  ) {
    return (parsed as { repos: unknown[] }).repos;
  }
  return null;
}

function normalizeRepoEntry(entry: unknown): RegisteredRepoPathEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const rawPath = typeof record.path === 'string'
    ? record.path
    : typeof record.localPath === 'string'
      ? record.localPath
      : null;

  if (!rawPath?.trim()) {
    return null;
  }

  return {
    ...record,
    path: normalizeRepoPath(rawPath),
  };
}

export async function readRepoPathRegistry(): Promise<RepoRegistryReadResult> {
  let raw: string;
  try {
    raw = await readFile(REPO_REGISTRY_PATH, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') {
      return { ok: true, repos: [] };
    }
    return unreadableRegistryResult();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return unreadableRegistryResult();
  }

  const entries = extractRepoEntries(parsed);
  if (!entries) {
    return unreadableRegistryResult();
  }

  const repos: RegisteredRepoPathEntry[] = [];
  for (const entry of entries) {
    const normalized = normalizeRepoEntry(entry);
    if (!normalized) {
      return unreadableRegistryResult();
    }
    repos.push(normalized);
  }

  return { ok: true, repos };
}

export async function resolveRepoPathFromRegistry(requestedPath: string): Promise<RepoRegistryResolveResult> {
  const normalizedRequestedPath = normalizeRepoPath(requestedPath);
  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    return {
      ok: false,
      message: registry.message,
      status: 500,
    };
  }

  const repo = registry.repos.find((entry) => entry.path === normalizedRequestedPath);
  if (!repo) {
    return {
      ok: false,
      message: `repoPath must match a path registered in ${REPO_REGISTRY_DISPLAY_PATH}.`,
      status: 400,
    };
  }

  if (!existsSync(normalizedRequestedPath)) {
    return {
      ok: false,
      message: 'repoPath is registered but does not exist on disk.',
      status: 400,
    };
  }

  return {
    ok: true,
    repo,
    repoRoot: normalizedRequestedPath,
  };
}

function lastOpenedMs(repo: RegisteredRepoPathEntry): number {
  const raw = typeof repo.lastOpenedAt === 'string' ? Date.parse(repo.lastOpenedAt) : NaN;
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Resolve the "Current project" selection — surfaces that offer it (mobile repo picker,
 * web-machine console) send no repoPath at all, so the server has to name one. Falling
 * back to `process.cwd()` silently drops CLI runtimes outside a git repo, where they
 * refuse to run and exit with no output.
 */
export async function resolveCurrentProjectRepo(): Promise<RepoRegistryResolveResult> {
  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    return { ok: false, message: registry.message, status: 500 };
  }

  const present = registry.repos.filter((repo) => existsSync(repo.path));
  if (present.length === 0) {
    return {
      ok: false,
      message: registry.repos.length === 0
        ? `No repository is registered on this desk — add one in o8, or pick a repo instead of "Current project".`
        : `No registered repository exists on disk. Check ${REPO_REGISTRY_DISPLAY_PATH}.`,
      status: 400,
    };
  }

  const newest = present.reduce(
    (best, repo) => (lastOpenedMs(repo) > lastOpenedMs(best) ? repo : best),
    present[0],
  );

  return { ok: true, repo: newest, repoRoot: newest.path };
}
