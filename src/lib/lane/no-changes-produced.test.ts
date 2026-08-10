import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetPacketDiffBaseFetchMemoForTest } from '@/lib/diff/base-resolution';
import { probeNoChangesProduced } from './no-changes-produced';

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

afterEach(() => {
  resetPacketDiffBaseFetchMemoForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('probeNoChangesProduced', () => {
  it('does not treat upstream commits as packet work when local main is stale', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-no-changes-produced-'));
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    const upstream = path.join(root, 'upstream');
    tempDirs.push(root);

    execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
    execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
    git(repo, ['checkout', '-b', 'main']);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    commitAll(repo, 'base');
    git(repo, ['push', '-u', 'origin', 'main']);

    execFileSync('git', ['clone', origin, upstream], { stdio: 'pipe' });
    git(upstream, ['checkout', 'main']);
    writeFileSync(path.join(upstream, 'upstream.txt'), 'upstream\n');
    const upstreamSha = commitAll(upstream, 'upstream work');
    git(upstream, ['push', 'origin', 'main']);

    git(repo, ['fetch', 'origin', 'main', '--quiet']);
    git(repo, ['checkout', '-b', 'packet', 'origin/main']);
    expect(git(repo, ['rev-list', '--count', 'main..HEAD'])).toBe('1');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(upstreamSha);

    await expect(probeNoChangesProduced(repo, 'main')).resolves.toEqual({
      commitsAhead: 0,
      comparisonRef: 'origin/main',
      statusPorcelain: '',
      noChangesProduced: true,
    });
  });
});
