interface RegisteredRepoScope {
  name: string;
  localPath: string;
}

interface LiveWorkspaceScope {
  repoName: string;
  repoPath: string;
}

function pathKey(value?: string | null): string {
  return (value ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/');
}

export function selectWorkspaceReadinessRepos<T extends RegisteredRepoScope>(params: {
  registeredRepos: T[];
  workspaces: LiveWorkspaceScope[];
}): Array<{ repo: T; repoNames: string[] }> {
  if (params.workspaces.length === 0) return [];

  const repoByKey = new Map<string, T>();
  for (const repo of params.registeredRepos) {
    const key = pathKey(repo.localPath);
    if (key && !repoByKey.has(key)) repoByKey.set(key, repo);
  }

  const namesByRepoKey = new Map<string, Set<string>>();
  for (const workspace of params.workspaces) {
    const workspacePath = pathKey(workspace.repoPath);
    if (!workspacePath) continue;

    let ownerKey = '';
    for (const repoKey of repoByKey.keys()) {
      if (
        (workspacePath === repoKey || workspacePath.startsWith(`${repoKey}/`))
        && repoKey.length > ownerKey.length
      ) {
        ownerKey = repoKey;
      }
    }
    if (!ownerKey) continue;

    const names = namesByRepoKey.get(ownerKey) ?? new Set<string>();
    if (workspace.repoName.trim()) names.add(workspace.repoName.trim());
    const registeredName = repoByKey.get(ownerKey)?.name.trim();
    if (registeredName) names.add(registeredName);
    namesByRepoKey.set(ownerKey, names);
  }

  return Array.from(namesByRepoKey, ([repoKey, repoNames]) => ({
    repo: repoByKey.get(repoKey)!,
    repoNames: Array.from(repoNames),
  }));
}
