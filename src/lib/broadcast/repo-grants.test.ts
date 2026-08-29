import { describe, expect, it } from 'vitest';

import {
  normalizeRepoGrant,
  normalizeRepoGrants,
  repoGrantMatchesIdentity,
  repoGrantMatchesRequest,
} from './repo-grants';

describe('spectator repository grants', () => {
  it('normalizes explicit name grants without treating bare names as authority', () => {
    expect(normalizeRepoGrant(' name:Local-Repo ')).toBe('name:local-repo');
    expect(normalizeRepoGrants(['name:Local-Repo', 'name:local-repo'])).toEqual(['name:local-repo']);
    expect(repoGrantMatchesIdentity({
      grant: 'local-repo',
      repoName: 'local-repo',
      repoRemote: '',
      repoPath: '/repos/local-repo',
      registeredRepoPath: '/repos/local-repo',
    })).toBe(false);
    expect(repoGrantMatchesRequest({
      grant: 'local-repo',
      requestedRepo: 'local-repo',
    })).toBe(false);
  });

  it('binds a name grant to one remote-less receipt artifact path', () => {
    const identity = {
      grant: 'name:local-repo',
      repoName: 'local-repo',
      repoRemote: '',
      registeredRepoPath: '/registered/local-repo',
    };
    expect(repoGrantMatchesIdentity({
      ...identity,
      repoPath: '/registered/local-repo',
    })).toBe(true);
    expect(repoGrantMatchesIdentity({
      ...identity,
      repoPath: '/other/local-repo',
    })).toBe(false);
    expect(repoGrantMatchesIdentity({
      ...identity,
      repoRemote: 'example.test/team/local-repo',
      repoPath: '/registered/local-repo',
    })).toBe(false);
  });

  it('preserves remote and absolute-path grant matching', () => {
    expect(repoGrantMatchesIdentity({
      grant: 'https://example.test/team/repo.git',
      repoName: 'repo',
      repoRemote: 'example.test/team/repo',
      repoPath: '/repos/repo',
    })).toBe(true);
    expect(repoGrantMatchesIdentity({
      grant: '/repos/repo',
      repoName: 'unrelated-name',
      repoRemote: '',
      repoPath: '/repos/repo',
    })).toBe(true);
    expect(repoGrantMatchesRequest({
      grant: 'name:repo',
      requestedRepo: 'repo',
      registeredRepoPath: '/repos/repo',
    })).toBe(true);
  });
});
