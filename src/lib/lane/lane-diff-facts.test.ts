import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lane } from '@/lib/lane/types';
import { getLaneSpokenDiffFacts, parseNameStatus } from './lane-diff-facts';
import {
  commitSpokenReviewSnapshot,
  SpokenReviewSnapshotChangedError,
} from './spoken-review-snapshot';

const tempRepos: string[] = [];

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createLaneRepo(): Lane {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-spoken-diff-'));
  tempRepos.push(repoPath);
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  git(repoPath, ['config', 'user.email', 'test@o8.local']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, ['add', 'tracked.txt']);
  git(repoPath, ['commit', '-m', 'base']);
  git(repoPath, ['checkout', '-b', 'packet/spoken-review']);
  writeFileSync(join(repoPath, 'committed.ts'), 'export const shipped = true;\n');
  git(repoPath, ['add', 'committed.ts']);
  git(repoPath, ['commit', '-m', 'packet change']);
  return {
    id: 'lane-spoken',
    projectId: null,
    label: 'Spoken review',
    repoPath,
    worktreePath: repoPath,
    branch: 'packet/spoken-review',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'codex:test',
    packetId: 'pkt-spoken',
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastEventAt: null,
    lastEventLabel: null,
  };
}

afterEach(() => {
  for (const path of tempRepos.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('parseNameStatus', () => {
  it('preserves additions, modifications, deletions, and rename destinations', () => {
    expect(parseNameStatus([
      'A', 'src/new.ts',
      'M', 'src/existing.ts',
      'D', 'src/removed.ts',
      'R095', 'src/old.ts', 'src/renamed.ts',
      '',
    ].join('\0'))).toEqual([
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/existing.ts', status: 'modified' },
      { path: 'src/removed.ts', status: 'deleted' },
      { path: 'src/renamed.ts', previousPath: 'src/old.ts', status: 'renamed' },
    ]);
  });

  it('binds committed, tracked dirty, and untracked paths to one HEAD', async () => {
    const lane = createLaneRepo();
    writeFileSync(join(lane.repoPath, 'tracked.txt'), 'dirty\n');
    writeFileSync(join(lane.repoPath, 'untracked.json'), '{"new":true}\n');

    const facts = await getLaneSpokenDiffFacts(lane);

    expect(facts.headSha).toBe(git(lane.repoPath, ['rev-parse', 'HEAD']));
    expect(facts.fileChanges).toEqual(expect.arrayContaining([
      { path: 'committed.ts', status: 'added' },
      { path: 'tracked.txt', status: 'modified' },
      { path: 'untracked.json', status: 'untracked' },
    ]));
    expect(facts.against).toBe(git(lane.repoPath, ['rev-parse', 'main']));

    writeFileSync(join(lane.repoPath, 'untracked.json'), '{"new":false}\n');
    const changedFacts = await getLaneSpokenDiffFacts(lane);
    expect(changedFacts.headSha).toBe(facts.headSha);
    expect(changedFacts.fingerprint).not.toBe(facts.fingerprint);
  });

  it('keeps the content fingerprint stable when reviewed untracked files are staged', async () => {
    const lane = createLaneRepo();
    writeFileSync(join(lane.repoPath, 'untracked.json'), '{"new":true}\n');
    const before = await getLaneSpokenDiffFacts(lane);

    git(lane.repoPath, ['add', '-A']);
    const after = await getLaneSpokenDiffFacts(lane);

    expect(after.snapshotTreeHash).toBe(before.snapshotTreeHash);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it('restores the original index when the worktree changes before reviewed staging', async () => {
    const lane = createLaneRepo();
    writeFileSync(join(lane.repoPath, 'tracked.txt'), 'reviewed\n');
    const reviewed = await getLaneSpokenDiffFacts(lane);
    writeFileSync(join(lane.repoPath, 'tracked.txt'), 'changed too late\n');

    await expect(commitSpokenReviewSnapshot({
      lane,
      commitMessage: 'commit reviewed snapshot',
      expectedFingerprint: reviewed.fingerprint,
    })).rejects.toBeInstanceOf(SpokenReviewSnapshotChangedError);
    expect(git(lane.repoPath, ['diff', '--cached', '--name-only'])).toBe('');
    expect(git(lane.repoPath, ['status', '--short'])).toContain('tracked.txt');
  });

  it('commits the reviewed worktree tree instead of a racing shared index', async () => {
    const lane = createLaneRepo();
    writeFileSync(join(lane.repoPath, 'tracked.txt'), 'unreviewed staged bytes\n');
    git(lane.repoPath, ['add', 'tracked.txt']);
    writeFileSync(join(lane.repoPath, 'tracked.txt'), 'reviewed worktree bytes\n');
    const reviewed = await getLaneSpokenDiffFacts(lane);

    const commitSha = await commitSpokenReviewSnapshot({
      lane,
      commitMessage: 'commit reviewed snapshot',
      expectedFingerprint: reviewed.fingerprint,
    });

    expect(git(lane.repoPath, ['show', `${commitSha}:tracked.txt`])).toBe('reviewed worktree bytes');
    expect(git(lane.repoPath, ['show', '--format=%P', '--no-patch', commitSha])).toBe(reviewed.headSha);
  });

  it('fails closed when the recorded lane branch cannot be resolved', async () => {
    const lane = createLaneRepo();
    lane.branch = 'packet/another-attempt';

    await expect(getLaneSpokenDiffFacts(lane)).rejects.toThrow('Branch unresolved');
  });
});
