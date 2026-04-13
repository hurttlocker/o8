/**
 * Resolve a GitHub repo full name (e.g., "hurttlocker/cortex-ide") to a local
 * filesystem path using the repo registry at ~/.o8/repos.json.
 */

import 'server-only';

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const REGISTRY_PATH = join(homedir(), '.o8', 'repos.json');

function getRemoteSlug(repoPath: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, timeout: 3000, encoding: 'utf-8' }).trim();
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function resolveRepoPath(repoFullName: string): string | null {
  const target = repoFullName.toLowerCase();

  if (!existsSync(REGISTRY_PATH)) return null;

  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const repos: Array<{ path: string }> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.repos) ? parsed.repos : [];

    for (const repo of repos) {
      if (!repo.path) continue;
      const expanded = resolve(repo.path.replace(/^~(?=\/|$)/, homedir()));
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
