import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-lane-creation-base-'));
const dataDir = path.join(root, 'data');
const worktreeRoot = path.join(root, 'worktrees');
mkdirSync(worktreeRoot, { recursive: true });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: root,
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/worktree/safety-hooks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => {}),
}));

const { closeDb } = await import('@/lib/db');
const { dispatch } = await import('@/lib/lane/commands');
const { getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { getLaneSpokenDiffFacts } = await import('@/lib/lane/lane-diff-facts');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { addRepo } = await import('@/lib/repos/registry');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function createStaleRegisteredRepo(): {
  repo: string;
  remoteHead: string;
  localHead: string;
} {
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'registered');
  const publisher = path.join(root, 'publisher');

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  const localHead = commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, publisher], { stdio: 'pipe' });
  git(publisher, ['checkout', 'main']);
  writeFileSync(
    path.join(publisher, 'upstream-only.ts'),
    Array.from({ length: 54 }, (_, index) => `export const upstream${index} = ${index};`).join('\n') + '\n',
  );
  commitAll(publisher, 'upstream one');
  writeFileSync(path.join(publisher, 'upstream-two.txt'), 'second upstream commit\n');
  const remoteHead = commitAll(publisher, 'upstream two');
  git(publisher, ['push', 'origin', 'main']);

  expect(git(repo, ['rev-parse', 'main'])).toBe(localHead);
  expect(git(repo, ['rev-list', '--count', 'main..origin/main'])).toBe('0');
  return { repo, remoteHead, localHead };
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('managed lane creation base', () => {
  it('pins the fetched remote base into the receipt and packet branch', async () => {
    const { repo, remoteHead, localHead } = createStaleRegisteredRepo();
    await addRepo(repo);
    const packetId = `pkt-creation-base-${Date.now()}`;
    const branch = `issue/creation-base-${Date.now()}`;

    const opened = await dispatch({
      verb: 'open_lane',
      repoPath: repo,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      actor: 'orchestrator',
    });
    expect(opened.ok).toBe(true);
    expect(git(repo, ['rev-parse', 'main'])).toBe(localHead);
    expect(git(repo, ['rev-parse', 'origin/main'])).toBe(remoteHead);
    expect(git(repo, ['rev-list', '--count', 'main..origin/main'])).toBe('2');

    const openEvent = getLaneEvents(opened.laneId!, 100)
      .find((event) => event.verb === 'open_lane');
    expect(openEvent?.payload).toMatchObject({
      baseCommit: remoteHead,
      baseCommitPinned: true,
    });

    const launch = await prepareLaunchWorktree({
      repoRoot: repo,
      agentType: 'codex',
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      laneId: opened.laneId!,
      isolationPreference: 'git-worktree',
    });
    expect(launch).not.toBeNull();
    const worktree = launch!.worktree;
    const bound = await dispatch({
      verb: 'bind_worktree',
      laneId: opened.laneId!,
      worktreePath: worktree.path,
      actor: 'system',
    });
    expect(bound.ok).toBe(true);

    writeFileSync(path.join(worktree.path, 'packet-only.ts'), 'export const packetOnly = true;\n');
    const packetHead = commitAll(worktree.path, 'packet change');
    expect(git(worktree.path, ['rev-parse', `${packetHead}^`])).toBe(remoteHead);
    setLaneStatus(opened.laneId!, 'reviewing', 'system', 'review_ready');

    const preview = await previewPacketMerge(packetId);
    expect(preview.diffBase).toMatchObject({
      requestedRef: remoteHead,
      comparisonRef: remoteHead,
      mergeBase: remoteHead,
      fetchedRemoteBase: false,
      usedFallback: false,
    });
    expect(preview.checks.find((check) => check.name === 'diff-budget')).toMatchObject({
      verdict: 'pass',
    });

    const facts = await getLaneSpokenDiffFacts(bound.lane!);
    expect(facts.changedFiles).toEqual(['packet-only.ts']);
    expect(git(worktree.path, ['diff', '--name-only', `${preview.diffBase!.comparisonRef}...HEAD`]))
      .toBe('packet-only.ts');
    expect(JSON.stringify(preview)).not.toContain('upstream-only.ts');
  }, 30_000);
});
