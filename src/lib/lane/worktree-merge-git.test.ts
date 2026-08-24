import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveCurrentBranch,
  type GitCommandRunner,
} from './worktree-merge-git';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

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

  it('requires a silent symbolic-ref exit 1 and a readable HEAD to prove detachment', async () => {
    let calls = 0;
    const detachedProbe: GitCommandRunner = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('detached'), { code: 1, stdout: '', stderr: '' });
      return { stdout: '0123456789abcdef\n', stderr: '' };
    };
    await expect(resolveCurrentBranch('/repo', detachedProbe)).resolves.toMatchObject({
      state: 'detached',
    });
    expect(calls).toBe(2);

    await expect(resolveCurrentBranch('/repo', failedProbe(1, 'guard failed')))
      .resolves.toMatchObject({
        state: 'unknown',
        evidence: expect.stringContaining('guard failed'),
      });
    await expect(resolveCurrentBranch('/repo', failedProbe(128, 'repository unavailable')))
      .resolves.toMatchObject({
        state: 'unknown',
        evidence: expect.stringContaining('repository unavailable'),
      });
  });

  it('does not mistake a materialization guard failure for detached HEAD', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-branch-guard-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoPath });
      execFileSync('git', [
        '-c', 'user.name=o8-test',
        '-c', 'user.email=o8@example.test',
        'commit', '-q', '--allow-empty', '-m', 'base',
      ], { cwd: repoPath });
      execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repoPath });
      const identity = await captureWorktreeMaterializationIdentity(repoPath);

      await expect(withWorktreeMaterializationExecution(repoPath, identity, () => (
        resolveCurrentBranch(repoPath, (cwd, args, opts) => materializationAwareExecFile(
          'git',
          args,
          { ...opts, cwd, env: { ...process.env, PATH: '/nonexistent' } },
        ))
      ))).resolves.toMatchObject({
        state: 'unknown',
        evidence: expect.stringContaining('Managed workspace command could not be resolved'),
      });

      await expect(withWorktreeMaterializationExecution(
        repoPath,
        identity,
        () => resolveCurrentBranch(repoPath),
      )).resolves.toMatchObject({ state: 'detached' });
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
