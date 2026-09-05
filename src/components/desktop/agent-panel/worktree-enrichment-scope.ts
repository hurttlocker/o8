interface WorktreeEnrichmentAgent {
  sessionKey: string;
  workspace?: string | null;
  worktree?: { path?: string | null } | null;
  runtimeSurface?: { cwd?: string | null } | null;
}

interface WorktreeEnrichmentWorkspace {
  sessionKey?: string | null;
  repoPath?: string | null;
}

function normalizePathValue(value?: string | null): string {
  return (value ?? '').trim().replace(/[\\/]+$/, '');
}

function pathKey(value?: string | null): string {
  return normalizePathValue(value).replace(/\\/g, '/');
}

function findOwningRepo(
  candidate: string | null | undefined,
  registeredReposByKey: Map<string, string>,
): string | null {
  const candidateKey = pathKey(candidate);
  if (!candidateKey) return null;

  let bestKey = '';
  let bestRepo: string | null = null;
  for (const [repoKey, repoPath] of registeredReposByKey) {
    if (
      (candidateKey === repoKey || candidateKey.startsWith(`${repoKey}/`))
      && repoKey.length > bestKey.length
    ) {
      bestKey = repoKey;
      bestRepo = repoPath;
    }
  }
  return bestRepo;
}

/**
 * Select only repositories that can enrich agents in the current inventory.
 * Registered repositories are a lookup boundary, not work to scan eagerly.
 */
export function deriveWorktreeEnrichmentRepoPaths(params: {
  agents: WorktreeEnrichmentAgent[];
  workspaces: WorktreeEnrichmentWorkspace[];
  registeredRepoPaths: string[];
}): string[] {
  if (params.agents.length === 0) return [];

  const registeredReposByKey = new Map<string, string>();
  for (const candidate of params.registeredRepoPaths) {
    const value = normalizePathValue(candidate);
    const key = pathKey(value);
    if (key && !registeredReposByKey.has(key)) {
      registeredReposByKey.set(key, value);
    }
  }

  const workspaceRepoBySession = new Map<string, string>();
  for (const workspace of params.workspaces) {
    const sessionKey = workspace.sessionKey?.trim();
    if (!sessionKey) continue;
    const repoPath = findOwningRepo(workspace.repoPath, registeredReposByKey);
    if (repoPath) workspaceRepoBySession.set(sessionKey, repoPath);
  }

  const selected = new Set<string>();
  for (const agent of params.agents) {
    const workspaceRepo = workspaceRepoBySession.get(agent.sessionKey);
    if (workspaceRepo) {
      selected.add(workspaceRepo);
      continue;
    }

    const candidates = [
      agent.worktree?.path,
      agent.runtimeSurface?.cwd,
      agent.workspace,
    ];
    for (const candidate of candidates) {
      const repoPath = findOwningRepo(candidate, registeredReposByKey);
      if (!repoPath) continue;
      selected.add(repoPath);
      break;
    }
  }

  return Array.from(selected);
}
