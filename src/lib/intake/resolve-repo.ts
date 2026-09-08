/**
 * Resolve a GitHub repo full name (e.g., "hurttlocker/o8") to a local
 * filesystem path using the canonical o8 data-dir repo registry.
 */

import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getRemoteSlug } from './remote-slug';

export function resolveRepoPath(repoFullName: string): string | null {
  const target = repoFullName.toLowerCase();
  const registryPath = join(getDataDir(), 'repos.json');

  if (!existsSync(registryPath)) return null;

  try {
    const raw = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const repos: Array<{ localPath?: string; path?: string }> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.repos) ? parsed.repos : [];

    for (const repo of repos) {
      const repoPath = repo.localPath ?? repo.path;
      if (!repoPath) continue;
      const expanded = resolve(repoPath.replace(/^~(?=\/|$)/, homedir()));
      if (!existsSync(expanded)) continue;

      // Match by git remote
      const slug = getRemoteSlug(expanded);
      if (slug === target) return expanded;

      // Fallback: match by directory name
      if (basename(expanded).toLowerCase() === target.split('/')[1]?.toLowerCase()) {
        return expanded;
      }
    }
  } catch {
    return null;
  }

  return null;
}
