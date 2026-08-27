import { execFileSync } from 'node:child_process';
import {
  afterAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path, { join } from 'node:path';

const suiteRoot = mkdtempSync(join(os.tmpdir(), 'o8-immutable-review-'));
const dataDir = join(suiteRoot, 'data');
mkdirSync(dataDir, { recursive: true });
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    windowsHide: true,
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface GitFixture {
  repoPath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
}

interface LocalAheadFixture {
  repoPath: string;
  worktreePath: string;
  branch: string;
  remoteBaseCommit: string;
  creationBaseCommit: string;
}

function createGitFixture(label: string): GitFixture {
  const repoPath = join(suiteRoot, label);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--initial-branch=main');
  git(repoPath, 'config', 'user.email', 'test@o8.test');
  git(repoPath, 'config', 'user.name', 'o8-test');
  writeFileSync(join(repoPath, 'review.txt'), 'base\n');
  git(repoPath, 'add', 'review.txt');
  git(repoPath, 'commit', '-m', 'base');
  const baseCommit = git(repoPath, 'rev-parse', 'HEAD');
  const branch = `inline/${label}`;
  git(repoPath, 'checkout', '-b', branch);
  writeFileSync(join(repoPath, 'review.txt'), 'base\nreviewed\n');
  git(repoPath, 'add', 'review.txt');
  git(repoPath, 'commit', '-m', 'reviewed change');
  const headCommit = git(repoPath, 'rev-parse', 'HEAD');
  const treeSha = git(repoPath, 'rev-parse', 'HEAD^{tree}');
  const recoveryRef = `refs/o8/recovery/${label}`;
  git(repoPath, 'update-ref', recoveryRef, headCommit);
  return { repoPath, branch, baseCommit, headCommit, treeSha, recoveryRef };
}

function createLocalAheadFixture(label: string): LocalAheadFixture {
  const root = join(suiteRoot, label);
  const origin = join(root, 'origin.git');
  const repoPath = join(root, 'operator');
  const worktreePath = join(root, 'packet');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'pipe' });
  git(repoPath, 'checkout', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@o8.test');
  git(repoPath, 'config', 'user.name', 'o8-test');
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, 'add', 'base.txt');
  git(repoPath, 'commit', '-m', 'base');
  const remoteBaseCommit = git(repoPath, 'rev-parse', 'HEAD');
  git(repoPath, 'push', '-u', 'origin', 'main');
  writeFileSync(join(repoPath, 'held-local.txt'), 'held local change\n');
  git(repoPath, 'add', 'held-local.txt');
  git(repoPath, 'commit', '-m', 'held local main commit');
  const creationBaseCommit = git(repoPath, 'rev-parse', 'HEAD');
  const branch = `inline/${label}`;
  git(repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'main');
  return { repoPath, worktreePath, branch, remoteBaseCommit, creationBaseCommit };
}

const movedHeadFixture = createGitFixture('moved-head');
const missingObjectFixture = createGitFixture('missing-object');
const materializedFixture = createGitFixture('materialized');
const transitionalFixture = createGitFixture('transitional');
const foreignSnapshotFixture = createGitFixture('foreign-snapshot');
const localAheadFixture = createLocalAheadFixture('local-ahead');

function repoEntry(id: string, fixture: GitFixture) {
  return {
    id,
    name: path.basename(fixture.repoPath),
    localPath: fixture.repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: '2026-08-14T00:00:00.000Z',
    lastOpenedAt: null,
    setup: {
      envMode: 'skip',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

const movedRepoUuid = 'repo-uuid-moved-head';
const missingRepoUuid = 'repo-uuid-missing-object';
const transitionalRepoUuid = 'repo-uuid-transitional';
const foreignSnapshotRepoUuid = 'repo-uuid-foreign-snapshot';
function writeRepoRegistry() {
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({
    version: 1,
    repos: [
      repoEntry(movedRepoUuid, movedHeadFixture),
      repoEntry(missingRepoUuid, missingObjectFixture),
      repoEntry(transitionalRepoUuid, transitionalFixture),
      repoEntry(foreignSnapshotRepoUuid, foreignSnapshotFixture),
    ],
  }));
}
writeRepoRegistry();

const { NextRequest } = await import('next/server');
const { createLane } = await import('@/lib/lane/registry');
const {
  createWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const { spokenReviewSnapshotFingerprint } = await import('@/lib/lane/lane-diff-facts');
const { runMergeGate } = await import('@/lib/lane/merge-gate');
const diffRoute = await import('@/app/api/lanes/[id]/diff/route');
const mergePreviewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const reviewStateRoute = await import('@/app/api/orchestrator/review-state/route');
const { closeDb } = await import('@/lib/db');

function operatorGet(url: string) {
  return new NextRequest(url, {
    method: 'GET',
    headers: { host: 'localhost:3001' },
  });
}

function parkFixture(
  fixture: GitFixture,
  repositoryUuid: string,
  packetId: string,
  laneId: string,
) {
  const fingerprint = spokenReviewSnapshotFingerprint(
    fixture.headCommit,
    fixture.baseCommit,
    fixture.treeSha,
  );
  const created = createWorkspaceSnapshot({
    repositoryUuid,
    packetId,
    laneId,
    originalPath: join(fixture.repoPath, '.parked-worktree'),
    branch: fixture.branch,
    baseCommit: fixture.baseCommit,
    headCommit: fixture.headCommit,
    treeSha: fixture.treeSha,
    recoveryRef: fixture.recoveryRef,
    diffFingerprint: fingerprint,
    sessionIdentities: [],
    creationId: `create-${packetId}`,
  });
  expect(created.status).toBe('created');
  let version = created.record.version;
  for (const [index, state] of ['parkable', 'hibernating', 'parked'].entries()) {
    const transitioned = transitionWorkspaceSnapshot({
      repositoryUuid,
      packetId,
      transitionId: `${packetId}-${state}`,
      expectedState: index === 0 ? 'materialized' : index === 1 ? 'parkable' : 'hibernating',
      expectedVersion: version,
      toState: state as 'parkable' | 'hibernating' | 'parked',
    });
    expect(transitioned.status).toBe('applied');
    if (transitioned.status === 'applied') version = transitioned.record.version;
  }
  return fingerprint;
}

afterAll(() => {
  closeDb();
  rmSync(suiteRoot, { recursive: true, force: true });
});

describe('parked lane review source', () => {
  it('renders the saved diff after the recorded branch moves and keeps merge unavailable', async () => {
    const packetId = 'packet-parked-moved-head';
    const lane = createLane({
      repoPath: movedHeadFixture.repoPath,
      worktreePath: join(movedHeadFixture.repoPath, '.parked-worktree'),
      branch: movedHeadFixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const fingerprint = parkFixture(movedHeadFixture, movedRepoUuid, packetId, lane.id);

    writeFileSync(join(movedHeadFixture.repoPath, 'review.txt'), 'base\nreviewed\nbranch moved\n');
    git(movedHeadFixture.repoPath, 'add', 'review.txt');
    git(movedHeadFixture.repoPath, 'commit', '-m', 'later branch change');
    expect(git(movedHeadFixture.repoPath, 'rev-parse', 'HEAD')).not.toBe(movedHeadFixture.headCommit);
    const movedRepositoryPath = `${movedHeadFixture.repoPath}-relocated`;
    renameSync(movedHeadFixture.repoPath, movedRepositoryPath);
    movedHeadFixture.repoPath = movedRepositoryPath;
    writeRepoRegistry();

    const response = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      packetId,
      headSha: movedHeadFixture.headCommit,
      base: movedHeadFixture.baseCommit,
      branch: movedHeadFixture.branch,
      worktreePath: null,
      reviewSource: 'immutable_snapshot',
      repositoryUuid: movedRepoUuid,
      mergeAvailable: false,
      diffFingerprint: fingerprint,
      treeSha: movedHeadFixture.treeSha,
      diff: expect.stringContaining('+reviewed'),
    });
    const freshResponse = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect((await freshResponse.json()).diff).not.toContain('branch moved');

    const preview = await mergePreviewRoute.GET(
      operatorGet(`http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`),
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      packetId,
      wouldMerge: false,
      blockers: ['workspace-parked'],
      branch: movedHeadFixture.branch,
      reviewSource: 'immutable_snapshot',
      diffBase: {
        comparisonRef: movedHeadFixture.baseCommit,
        mergeBase: movedHeadFixture.baseCommit,
      },
    });

    const spoken = await reviewStateRoute.GET(
      operatorGet(`http://localhost:3001/api/orchestrator/review-state?packetId=${packetId}&spoken=1`),
    );
    expect(spoken.status).toBe(200);
    await expect(spoken.json()).resolves.toMatchObject({
      packetId,
      spokenReview: {
        evidence: {
          headSha: movedHeadFixture.headCommit,
          fingerprint,
          diffBase: movedHeadFixture.baseCommit,
        },
        files: {
          count: 1,
          touched: ['review.txt'],
          omittedCount: 0,
        },
      },
    });
  });

  it('fails closed when a saved Git object is missing', async () => {
    const packetId = 'packet-parked-missing-object';
    const lane = createLane({
      repoPath: missingObjectFixture.repoPath,
      worktreePath: join(missingObjectFixture.repoPath, '.parked-worktree'),
      branch: missingObjectFixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    parkFixture(missingObjectFixture, missingRepoUuid, packetId, lane.id);

    const objectsPath = git(missingObjectFixture.repoPath, 'rev-parse', '--git-path', 'objects');
    const treeObjectPath = path.resolve(
      missingObjectFixture.repoPath,
      objectsPath,
      missingObjectFixture.treeSha.slice(0, 2),
      missingObjectFixture.treeSha.slice(2),
    );
    expect(existsSync(treeObjectPath)).toBe(true);
    rmSync(treeObjectPath);

    const response = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'immutable_review_unavailable',
        packetId,
      },
    });
    expect(payload).not.toHaveProperty('diff');
  });

  it('keeps the existing materialized worktree route behavior', async () => {
    const packetId = 'packet-materialized-review';
    const lane = createLane({
      repoPath: materializedFixture.repoPath,
      worktreePath: materializedFixture.repoPath,
      branch: materializedFixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const response = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      packetId,
      headSha: materializedFixture.headCommit,
      base: 'main',
      branch: materializedFixture.branch,
      reviewSource: 'materialized',
      mergeAvailable: true,
      diff: expect.stringContaining('+reviewed'),
    });
    expect(realpathSync.native(payload.worktreePath)).toBe(realpathSync.native(materializedFixture.repoPath));
  });

  it('keeps held local base commits out of live diff, spoken review, and merge-gate evidence', async () => {
    const packetId = 'packet-local-ahead-review';
    const lane = createLane({
      repoPath: localAheadFixture.repoPath,
      worktreePath: localAheadFixture.worktreePath,
      branch: localAheadFixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    writeFileSync(join(localAheadFixture.worktreePath, 'packet.txt'), 'packet change\n');
    git(localAheadFixture.worktreePath, 'add', 'packet.txt');
    git(localAheadFixture.worktreePath, 'commit', '-m', 'packet change');

    const response = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      packetId,
      diffBase: {
        requestedRef: localAheadFixture.creationBaseCommit,
        comparisonRef: localAheadFixture.creationBaseCommit,
        mergeBase: localAheadFixture.creationBaseCommit,
        fetchedRemoteBase: false,
        usedFallback: false,
      },
      diff: expect.stringContaining('+packet change'),
    });
    expect(payload.diff).not.toContain('held-local.txt');
    expect(git(localAheadFixture.repoPath, 'rev-parse', 'origin/main'))
      .toBe(localAheadFixture.remoteBaseCommit);

    const spoken = await reviewStateRoute.GET(
      operatorGet(`http://localhost:3001/api/orchestrator/review-state?packetId=${packetId}&spoken=1`),
    );
    expect(spoken.status).toBe(200);
    await expect(spoken.json()).resolves.toMatchObject({
      packetId,
      spokenReview: {
        evidence: { diffBase: localAheadFixture.creationBaseCommit },
        files: { count: 1, touched: ['packet.txt'], omittedCount: 0 },
      },
    });

    const gate = await runMergeGate(lane);
    expect(gate.diffBase).toEqual(expect.objectContaining({
      requestedRef: localAheadFixture.creationBaseCommit,
      comparisonRef: localAheadFixture.creationBaseCommit,
      mergeBase: localAheadFixture.creationBaseCommit,
      fetchedRemoteBase: false,
      usedFallback: false,
    }));
    expect(gate.violations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'held-local.txt' }),
    ]));
  }, 20_000);

  it.each(['hibernating', 'restoring'] as const)(
    'blocks mutable review while a snapshot is %s',
    async (state) => {
      const packetId = `packet-${state}-review`;
      const lane = createLane({
        repoPath: transitionalFixture.repoPath,
        worktreePath: transitionalFixture.repoPath,
        branch: transitionalFixture.branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
      });
      const created = createWorkspaceSnapshot({
        repositoryUuid: transitionalRepoUuid,
        packetId,
        laneId: lane.id,
        originalPath: transitionalFixture.repoPath,
        branch: transitionalFixture.branch,
        baseCommit: transitionalFixture.baseCommit,
        headCommit: transitionalFixture.headCommit,
        treeSha: transitionalFixture.treeSha,
        recoveryRef: transitionalFixture.recoveryRef,
        diffFingerprint: spokenReviewSnapshotFingerprint(
          transitionalFixture.headCommit,
          transitionalFixture.baseCommit,
          transitionalFixture.treeSha,
        ),
        sessionIdentities: [],
        creationId: `create-${packetId}`,
      });
      let current = created.record;
      const states = state === 'hibernating'
        ? ['parkable', 'hibernating'] as const
        : ['parkable', 'hibernating', 'parked', 'restoring'] as const;
      for (const nextState of states) {
        const result = transitionWorkspaceSnapshot({
          repositoryUuid: transitionalRepoUuid,
          packetId,
          transitionId: `${packetId}-${nextState}`,
          expectedState: current.state,
          expectedVersion: current.version,
          toState: nextState,
        });
        expect(result.status).toBe('applied');
        current = result.record!;
      }

      const response = await diffRoute.GET(
        operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
        { params: Promise.resolve({ id: lane.id }) },
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'immutable_review_unavailable', packetId },
      });
    },
  );

  it('does not attach another repository snapshot to a lane with the same packet id', async () => {
    const packetId = 'packet-cross-repo-review';
    const lane = createLane({
      repoPath: materializedFixture.repoPath,
      worktreePath: materializedFixture.repoPath,
      branch: materializedFixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    parkFixture(
      foreignSnapshotFixture,
      foreignSnapshotRepoUuid,
      packetId,
      'lane-owned-by-another-repository',
    );

    const response = await diffRoute.GET(
      operatorGet(`http://localhost:3001/api/lanes/${lane.id}/diff`),
      { params: Promise.resolve({ id: lane.id }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      reviewSource: 'materialized',
      packetId,
      headSha: materializedFixture.headCommit,
    });
  });
});
