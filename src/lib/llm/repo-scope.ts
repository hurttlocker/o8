import 'server-only';

import path from 'node:path';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { findRepoByLocalPath } from '@/lib/repos/registry';

export const LLM_REPO_PATH_HEADER = 'x-cortex-repo-path';

export function getDefaultLlmRepoRoot() {
  return process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
}

export async function resolveRegisteredRepoScope(requestedPath?: string | null): Promise<{
  repoRoot: string | null;
  repo: RepoRegistryEntry | null;
}> {
  if (!requestedPath?.trim()) {
    return { repoRoot: null, repo: null };
  }

  const normalized = path.resolve(requestedPath.trim());
  const repo = await findRepoByLocalPath(normalized).catch(() => null);
  if (!repo) {
    return { repoRoot: null, repo: null };
  }

  return {
    repoRoot: repo.localPath,
    repo,
  };
}

export async function resolveRepoScopeFromHeaders(headers: Headers): Promise<{
  repoRoot: string | null;
  repo: RepoRegistryEntry | null;
  usedDefault: boolean;
}> {
  const requestedPath = headers.get(LLM_REPO_PATH_HEADER)?.trim();
  if (!requestedPath) {
    return {
      repoRoot: getDefaultLlmRepoRoot(),
      repo: null,
      usedDefault: true,
    };
  }

  const scoped = await resolveRegisteredRepoScope(requestedPath);
  return {
    ...scoped,
    usedDefault: false,
  };
}
