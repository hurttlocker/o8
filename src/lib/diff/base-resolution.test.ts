import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolvePacketDiffBase } from './base-resolution';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-`));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  const baseSha = commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  return { root: realpathSync(root), origin: realpathSync(origin), repo: realpathSync(repo), baseSha };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolvePacketDiffBase', () => {
  it('fetches origin main and computes merge-base against the refreshed remote base', async () => {
    const { origin, repo, baseSha } = makeRepo('o8-diff-base');
    const remoteClone = join(repo, '..', 'remote-clone');
    execFileSync('git', ['clone', origin, remoteClone], { stdio: 'pipe' });
    git(remoteClone, ['checkout', 'main']);
    git(remoteClone, ['config', 'user.name', 'o8-test']);
    git(remoteClone, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(remoteClone, 'upstream.txt'), 'upstream\n');
    const upstreamSha = commitAll(remoteClone, 'upstream');
    git(remoteClone, ['push', 'origin', 'main']);

    git(repo, ['fetch', 'origin', 'main', '--quiet']);
    git(repo, ['checkout', '-b', 'packet', 'origin/main']);
    writeFileSync(join(repo, 'packet.txt'), 'packet\n');
    const headSha = commitAll(repo, 'packet');
    git(repo, ['update-ref', 'refs/remotes/origin/main', baseSha]);

    const result = await resolvePacketDiffBase(repo, 'main', headSha);

    expect(result.fetchedRemoteBase).toBe(true);
    expect(result.usedFallback).toBe(false);
    expect(result.comparisonRef).toBe('origin/main');
    expect(result.mergeBase).toBe(upstreamSha);
  });

  it('falls back to local main with a provenance warning when origin cannot be fetched', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'o8-diff-base-local-'));
    tempDirs.push(root);
    const repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
    git(repo, ['config', 'user.name', 'o8-test']);
    git(repo, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(repo, 'file.txt'), 'base\n');
    const baseSha = commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet']);
    writeFileSync(join(repo, 'packet.txt'), 'packet\n');
    const headSha = commitAll(repo, 'packet');

    const result = await resolvePacketDiffBase(repo, 'main', headSha, 100);

    expect(result.fetchedRemoteBase).toBe(false);
    expect(result.usedFallback).toBe(true);
    expect(result.warning).toContain('using local main');
    expect(result.comparisonRef).toBe('main');
    expect(result.mergeBase).toBe(baseSha);
  });
});
