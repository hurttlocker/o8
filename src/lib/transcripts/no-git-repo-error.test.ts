import { describe, expect, it } from 'vitest';
import { parseNoGitRepoError } from './no-git-repo-error';

describe('parseNoGitRepoError', () => {
  it('extracts the repo path from the orchestrator error block', () => {
    expect(parseNoGitRepoError(
      'Orchestrator error: /Users/operator/o8 isn\'t a Git repository — run "git init" there, then try again.',
    )).toEqual({ repoPath: '/Users/operator/o8' });
  });

  it('preserves spaces in the extracted repo path', () => {
    expect(parseNoGitRepoError(
      '/Users/operator/My Project isn\'t a Git repository — run "git init" there, then try again.',
    )).toEqual({ repoPath: '/Users/operator/My Project' });
  });

  it('returns null for unrelated and pathless errors', () => {
    expect(parseNoGitRepoError('Orchestrator error: spawn failed')).toBeNull();
    expect(parseNoGitRepoError("Orchestrator error: isn't a Git repository")).toBeNull();
    expect(parseNoGitRepoError(null)).toBeNull();
  });

  it('refuses non-path prefixes like the dispatch gate message', () => {
    expect(parseNoGitRepoError(
      "This folder isn't a Git repository — initialize Git to dispatch agents into it.",
    )).toBeNull();
  });
});
