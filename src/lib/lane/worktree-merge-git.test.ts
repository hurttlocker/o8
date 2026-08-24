import { describe, expect, it } from 'vitest';

import {
  resolveCurrentBranch,
  type GitCommandRunner,
} from './worktree-merge-git';

function failedProbe(code: number, stderr: string): GitCommandRunner {
  return async () => {
    throw Object.assign(new Error(stderr), { code, stdout: '', stderr });
  };
}

describe('resolveCurrentBranch', () => {
  it('returns an attached branch from symbolic-ref output', async () => {
    const runGit: GitCommandRunner = async () => ({
      stdout: 'inline/reviewed-work\n',
      stderr: '',
    });

    await expect(resolveCurrentBranch('/repo', runGit)).resolves.toMatchObject({
      state: 'attached',
      branch: 'inline/reviewed-work',
    });
  });

  it('treats an empty successful probe as unknown rather than detached', async () => {
    const runGit: GitCommandRunner = async () => ({ stdout: '', stderr: '' });

    await expect(resolveCurrentBranch('/repo', runGit)).resolves.toMatchObject({
      state: 'unknown',
      evidence: expect.stringContaining('returned no branch name'),
    });
  });

  it('accepts only symbolic-ref exit 1 as proof of detachment', async () => {
    await expect(resolveCurrentBranch('/repo', failedProbe(1, ''))).resolves.toMatchObject({
      state: 'detached',
    });
    await expect(resolveCurrentBranch('/repo', failedProbe(128, 'repository unavailable')))
      .resolves.toMatchObject({
        state: 'unknown',
        evidence: expect.stringContaining('repository unavailable'),
      });
  });
});
