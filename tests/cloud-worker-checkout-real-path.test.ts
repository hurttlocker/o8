import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { cloneRepoForRun, commitWorkerChanges, pushRemoteBranch } from '../scripts/worker/clone-repo';

const root = mkdtempSync(path.join(tmpdir(), 'o8-pinned-checkout-'));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function fixture() {
  const dir = mkdtempSync(path.join(root, 'fixture-'));
  const source = path.join(dir, 'source');
  const bare = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', source]);
  git(source, 'config', 'user.name', 'Checkout Fixture');
  git(source, 'config', 'user.email', 'fixture@o8.invalid');
  writeFileSync(path.join(source, 'base.txt'), 'ancestor\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'ancestor');
  const ancestor = git(source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'base.txt'), 'reviewed\n');
  git(source, 'commit', '--quiet', '-am', 'reviewed base');
  const baseSha = git(source, 'rev-parse', 'HEAD');
  git(source, 'tag', 'reviewed');
  writeFileSync(path.join(source, 'later.txt'), 'must not enter the worker checkout\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'later main commit');
  const later = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '--quiet', '-b', 'unrelated', ancestor);
  writeFileSync(path.join(source, 'unrelated.bin'), Buffer.alloc(1024 * 1024, 42));
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'unrelated history');
  const unrelated = git(source, 'rev-parse', 'HEAD');
  const unrelatedBlob = git(source, 'rev-parse', 'HEAD:unrelated.bin');
  execFileSync('git', ['clone', '--quiet', '--bare', source, bare]);
  return { dir, bare, ancestor, baseSha, later, unrelated, unrelatedBlob };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('remote worker pinned checkout through real Git', () => {
  it('fetches exactly the reviewed base, omits unrelated history, and pushes its result', async () => {
    const remote = fixture();
    const branch = 'o8/pinned-result';
    const clone = await cloneRepoForRun({
      repoUrl: remote.bare, baseRef: remote.baseSha.toUpperCase(), remoteBranch: branch,
      workDir: path.join(remote.dir, 'attempt-1'),
    });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(remote.baseSha);
    expect(git(clone, 'branch', '--show-current')).toBe(branch);
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(clone, 'rev-list', '--all', '--count')).toBe('1');
    expect(git(clone, 'tag', '--list')).toBe('');
    expect(git(clone, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('');
    for (const object of [remote.ancestor, remote.later, remote.unrelated, remote.unrelatedBlob]) {
      expect(() => git(clone, 'cat-file', '-e', object)).toThrow();
    }
    expect(readFileSync(path.join(clone, 'base.txt'), 'utf8')).toBe('reviewed\n');
    expect(existsSync(path.join(clone, 'later.txt'))).toBe(false);
    writeFileSync(path.join(clone, 'result.txt'), 'done\n');
    expect(await commitWorkerChanges(clone, remote.baseSha)).toEqual([
      { path: 'result.txt', status: 'added', additions: 1, deletions: 0 },
    ]);
    const resultSha = await pushRemoteBranch(clone, branch);
    expect(git(remote.bare, 'rev-parse', `refs/heads/${branch}`)).toBe(resultSha);
    expect(git(remote.bare, 'rev-parse', `${resultSha}^`)).toBe(remote.baseSha);
    expect(git(remote.bare, 'show', `${resultSha}:result.txt`)).toBe('done');
  });

  it('atomically reserves a fresh attempt and never overwrites a prior checkout', async () => {
    const remote = fixture();
    const options = {
      repoUrl: remote.bare, baseRef: remote.baseSha, remoteBranch: 'o8/fresh-attempt',
      workDir: path.join(remote.dir, 'attempt'),
    };
    const results = await Promise.allSettled([cloneRepoForRun(options), cloneRepoForRun(options)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.message).toContain('fresh --workspace-dir');
    const clone = path.join(options.workDir, 'repo');
    writeFileSync(path.join(clone, 'uncommitted.txt'), 'preserve me');
    await expect(cloneRepoForRun(options)).rejects.toThrow('fresh --workspace-dir');
    expect(readFileSync(path.join(clone, 'uncommitted.txt'), 'utf8')).toBe('preserve me');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(remote.baseSha);
  });

  it('fails a missing pinned revision without broadening history and retries in a new attempt', async () => {
    const remote = fixture();
    const failedDir = path.join(remote.dir, 'failed');
    await expect(cloneRepoForRun({
      repoUrl: remote.bare, baseRef: 'f'.repeat(40), remoteBranch: 'o8/missing', workDir: failedDir,
    })).rejects.toThrow('git fetch failed');
    expect(existsSync(path.join(failedDir, 'repo', '.git'))).toBe(true);
    expect(() => git(path.join(failedDir, 'repo'), 'rev-parse', '--verify', 'HEAD')).toThrow();
    const clone = await cloneRepoForRun({
      repoUrl: remote.bare, baseRef: remote.baseSha, remoteBranch: 'o8/retry',
      workDir: path.join(remote.dir, 'retry'),
    });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(remote.baseSha);
  });

  it('rejects unpinned refs, invalid branches, and option-like URLs before creating a checkout', async () => {
    const remote = fixture();
    const workDir = path.join(remote.dir, 'invalid');
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, remoteBranch: 'o8/valid', workDir };
    await expect(cloneRepoForRun({ ...options, baseRef: 'main' })).rejects.toThrow('full pinned commit');
    await expect(cloneRepoForRun({ ...options, remoteBranch: '--upload-pack=unexpected' })).rejects.toThrow('git check-ref-format failed');
    await expect(cloneRepoForRun({ ...options, repoUrl: '--config=unexpected' })).rejects.toThrow('repo URL is invalid');
    expect(existsSync(workDir)).toBe(false);
  });

  it('honors cancellation before checkout creation', async () => {
    const controller = new AbortController();
    controller.abort();
    const workDir = path.join(root, 'pre-aborted');
    await expect(cloneRepoForRun({
      repoUrl: path.join(root, 'unused'), baseRef: 'a'.repeat(40), remoteBranch: 'o8/cancelled',
      workDir, signal: controller.signal,
    })).rejects.toThrow('operation aborted');
    expect(existsSync(workDir)).toBe(false);
  });

  it('cancels an in-flight real Git fetch and suppresses credential-bearing diagnostics', async () => {
    const controller = new AbortController();
    let requests = 0;
    const server = createServer(() => { requests += 1; controller.abort(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const started = Date.now();
    try {
      const error = await cloneRepoForRun({
        repoUrl: `http://fixture-user:fixture-secret@127.0.0.1:${port}/repo.git`,
        baseRef: 'a'.repeat(40), remoteBranch: 'o8/cancel-fetch',
        workDir: path.join(root, 'in-flight'), signal: controller.signal,
      }).catch((failure: Error) => failure);
      expect(requests).toBeGreaterThan(0);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('[worker/clone-repo] operation aborted');
      expect((error as Error).message).not.toContain('fixture-secret');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
