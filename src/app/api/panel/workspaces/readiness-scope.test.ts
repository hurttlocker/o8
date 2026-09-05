import { describe, expect, it } from 'vitest';

import { selectWorkspaceReadinessRepos } from './readiness-scope';

describe('workspace readiness scope', () => {
  it('does not probe any registered repository without a live workspace', () => {
    const registeredRepos = Array.from({ length: 1_000 }, (_, index) => ({
      id: `repo-${index}`,
      name: `repo-${index}`,
      localPath: `/repos/repo-${index}`,
    }));

    expect(selectWorkspaceReadinessRepos({
      registeredRepos,
      workspaces: [],
    })).toEqual([]);
  });

  it('selects only repositories backing live workspaces', () => {
    const selected = selectWorkspaceReadinessRepos({
      registeredRepos: [
        { id: 'one', name: 'one', localPath: '/repos/one' },
        { id: 'two', name: 'two', localPath: '/repos/two' },
        { id: 'three', name: 'three', localPath: '/repos/three' },
      ],
      workspaces: [
        { repoName: 'display-one', repoPath: '/repos/one' },
        { repoName: 'display-one-again', repoPath: '/repos/one/worktree' },
      ],
    });

    expect(selected).toEqual([{
      repo: { id: 'one', name: 'one', localPath: '/repos/one' },
      repoNames: ['display-one', 'one', 'display-one-again'],
    }]);
  });

  it('chooses the longest registered root for a nested workspace', () => {
    const selected = selectWorkspaceReadinessRepos({
      registeredRepos: [
        { id: 'mono', name: 'mono', localPath: '/repos/mono' },
        { id: 'app', name: 'app', localPath: '/repos/mono/packages/app' },
      ],
      workspaces: [{ repoName: 'app-workspace', repoPath: '/repos/mono/packages/app/worktree' }],
    });

    expect(selected.map((target) => target.repo.id)).toEqual(['app']);
  });
});
