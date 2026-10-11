import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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

function fixture(largeBase = false) {
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
  if (largeBase) {
    writeFileSync(path.join(source, 'payload.bin'), randomBytes(1024 * 1024));
    git(source, 'add', 'payload.bin');
  }
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

  it('reuses only base objects in independent attempts that survive cache deletion and push', async () => {
    const remote = fixture();
    const cacheDir = path.join(remote.dir, 'cache');
    const receipts: Array<{ cacheHit: boolean; durationMs: number }> = [];
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir,
      onCheckout: (receipt: { cacheHit: boolean; durationMs: number }) => { receipts.push(receipt); } };
    const first = await cloneRepoForRun({ ...options, remoteBranch: 'o8/cold', workDir: path.join(remote.dir, 'cold') });
    expect(existsSync(cacheDir)).toBe(true);
    expect(readdirSync(cacheDir)).toHaveLength(1);
    writeFileSync(path.join(first, 'previous-task.txt'), 'must stay in the first attempt');
    await commitWorkerChanges(first, remote.baseSha);
    const second = await cloneRepoForRun({ ...options, remoteBranch: 'o8/warm', workDir: path.join(remote.dir, 'warm') });
    expect(receipts.map((receipt) => receipt.cacheHit)).toEqual([false, true]);
    expect(receipts.every((receipt) => receipt.durationMs >= 0)).toBe(true);
    expect(git(second, 'rev-parse', 'HEAD')).toBe(remote.baseSha);
    expect(git(second, 'rev-list', '--all', '--count')).toBe('1');
    expect(git(second, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/o8/warm');
    expect(existsSync(path.join(second, 'previous-task.txt'))).toBe(false);
    expect(existsSync(path.join(second, '.git/objects/info/alternates'))).toBe(false);
    rmSync(cacheDir, { recursive: true });
    git(second, 'fsck', '--strict');
    writeFileSync(path.join(second, 'warm-result.txt'), 'done\n');
    await commitWorkerChanges(second, remote.baseSha);
    const resultSha = await pushRemoteBranch(second, 'o8/warm');
    expect(git(remote.bare, 'rev-parse', 'refs/heads/o8/warm')).toBe(resultSha);
    console.log('[worker/checkout] checkout timing fixture', JSON.stringify(receipts));
  });

  it('still contacts the exact upstream on a cache hit and refuses unavailable access', async () => {
    const remote = fixture();
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir: path.join(remote.dir, 'cache') };
    await cloneRepoForRun({ ...options, remoteBranch: 'o8/first', workDir: path.join(remote.dir, 'first') });
    renameSync(remote.bare, `${remote.bare}.unavailable`);
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/denied', workDir: path.join(remote.dir, 'denied') }))
      .rejects.toThrow('git fetch failed');
    expect(() => git(path.join(remote.dir, 'denied/repo'), 'rev-parse', '--verify', 'HEAD')).toThrow();
  });

  it('actually avoids transferring the pinned pack again while retaining a fresh upstream fetch', async () => {
    const remote = fixture(true);
    const cacheDir = path.join(remote.dir, 'cache');
    const previousTrace = process.env.GIT_TRACE_PACKFILE;
    const bytes: number[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const trace = path.join(remote.dir, `transfer-${i}.bin`);
        process.env.GIT_TRACE_PACKFILE = trace;
        await cloneRepoForRun({ repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir,
          remoteBranch: `o8/transfer-${i}`, workDir: path.join(remote.dir, `transfer-${i}`) });
        bytes.push(statSync(trace).size);
      }
      expect(bytes[0]).toBeGreaterThan(1024 * 1024);
      expect(bytes[1]).toBeLessThan(bytes[0]! / 10);
      console.log('[worker/checkout] actual upstream pack bytes', JSON.stringify(bytes));
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE_PACKFILE;
      else process.env.GIT_TRACE_PACKFILE = previousTrace;
    }
  });

  it('refuses a previously cached commit that the upstream no longer has', async () => {
    const remote = fixture();
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir: path.join(remote.dir, 'cache') };
    await cloneRepoForRun({ ...options, remoteBranch: 'o8/before-removal', workDir: path.join(remote.dir, 'before-removal') });
    for (const ref of git(remote.bare, 'for-each-ref', '--format=%(refname)').split('\n')) {
      git(remote.bare, 'update-ref', '-d', ref);
    }
    git(remote.bare, 'reflog', 'expire', '--expire=now', '--all');
    git(remote.bare, 'gc', '--prune=now');
    expect(() => git(remote.bare, 'cat-file', '-e', remote.baseSha)).toThrow();
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/removed', workDir: path.join(remote.dir, 'removed') }))
      .rejects.toThrow('git fetch failed');
  });

  it('checks cached object integrity and refuses object alternates', async () => {
    const remote = fixture();
    const cacheDir = path.join(remote.dir, 'cache');
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir };
    await cloneRepoForRun({ ...options, remoteBranch: 'o8/intact', workDir: path.join(remote.dir, 'intact') });
    const entry = path.join(cacheDir, readdirSync(cacheDir)[0]!);
    const packDir = path.join(entry, 'objects/pack');
    const loose = path.join(entry, 'objects', remote.baseSha.slice(0, 2), remote.baseSha.slice(2));
    const pack = existsSync(loose) ? loose : path.join(packDir, readdirSync(packDir).find((name) => name.endsWith('.pack'))!);
    const original = readFileSync(pack);
    chmodSync(pack, 0o600);
    writeFileSync(pack, Buffer.alloc(original.length));
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/corrupt-object', workDir: path.join(remote.dir, 'corrupt-object') }))
      .rejects.toThrow('git fsck failed');
    writeFileSync(pack, original);
    writeFileSync(path.join(entry, 'objects/info/alternates'), '/untrusted-object-dependency');
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/alternates', workDir: path.join(remote.dir, 'alternates') }))
      .rejects.toThrow(/[Rr]epository cache object/);
  });

  it('publishes one complete cache under concurrent cold attempts and scopes it to the source', async () => {
    const remote = fixture();
    const cacheDir = path.join(remote.dir, 'cache');
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir };
    const results = await Promise.all([0, 1].map((i) => cloneRepoForRun({ ...options,
      remoteBranch: `o8/parallel-${i}`, workDir: path.join(remote.dir, `parallel-${i}`) })));
    expect(readdirSync(cacheDir)).toHaveLength(1);
    for (const clone of results) expect(git(clone, 'rev-parse', 'HEAD')).toBe(remote.baseSha);
    const another = fixture();
    await cloneRepoForRun({ ...options, repoUrl: another.bare, baseRef: another.baseSha,
      remoteBranch: 'o8/other-source', workDir: path.join(remote.dir, 'other-source') });
    expect(readdirSync(cacheDir)).toHaveLength(2);
  });

  it('rejects a corrupted cache manifest and a symlink cache without touching their target', async () => {
    const remote = fixture();
    const cacheDir = path.join(remote.dir, 'cache');
    const options = { repoUrl: remote.bare, baseRef: remote.baseSha, cacheDir };
    await cloneRepoForRun({ ...options, remoteBranch: 'o8/create-cache', workDir: path.join(remote.dir, 'first') });
    const entry = path.join(cacheDir, readdirSync(cacheDir)[0]!);
    writeFileSync(path.join(entry, 'manifest.json'), '{}');
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/corrupt', workDir: path.join(remote.dir, 'corrupt') }))
      .rejects.toThrow(/[Rr]epository cache/);
    const saved = `${entry}.preserved`;
    renameSync(entry, saved);
    symlinkSync(saved, entry, 'dir');
    await expect(cloneRepoForRun({ ...options, remoteBranch: 'o8/symlink', workDir: path.join(remote.dir, 'symlink') }))
      .rejects.toThrow(/[Rr]epository cache/);
    expect(readFileSync(path.join(saved, 'manifest.json'), 'utf8')).toBe('{}');
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
