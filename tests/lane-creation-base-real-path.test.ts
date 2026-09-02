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
const { findLaneByPacket, getLaneEvents, listLanes, setLaneStatus } = await import('@/lib/lane/registry');
const { getLaneSpokenDiffFacts } = await import('@/lib/lane/lane-diff-facts');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { addRepo } = await import('@/lib/repos/registry');
const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
const { fetchUnreachableCooldownRetrySeconds } = await import('@/lib/runtime/fetch-unreachable-recovery');
const { getRuntime } = await import('@/lib/runtimes');
const { listInboxItems } = await import('@/lib/supervisor/inbox');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(
  cwd: string,
  message: string,
  dates?: { author: string; committer: string },
): string {
  git(cwd, ['add', '-A']);
  execFileSync('git', [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: dates ? {
      ...process.env,
      GIT_AUTHOR_DATE: dates.author,
      GIT_COMMITTER_DATE: dates.committer,
    } : process.env,
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function createUnreachableRegisteredRepo(label: string): { origin: string; repo: string } {
  const origin = path.join(root, `${label}-origin.git`);
  const repo = path.join(root, `${label}-registered`);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  writeFileSync(path.join(repo, 'README.md'), 'stale base\n');
  commitAll(repo, 'stale base', {
    author: '2020-01-01T00:00:00Z',
    committer: '2020-01-01T00:00:00Z',
  });
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-url', 'origin', path.join(root, `${label}-missing-origin.git`)]);
  return { origin, repo };
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

  it('holds lane creation behind a packet-correlated receipt, cooldown, and self-heal', async () => {
    const { origin, repo } = createUnreachableRegisteredRepo('lane-recovery');
    await addRepo(repo);
    const packetId = `pkt-fetch-unreachable-${Date.now()}`;
    const branch = `issue/fetch-unreachable-${Date.now()}`;
    const failedAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(failedAt);

    try {
      const opened = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        actor: 'orchestrator',
      });

      expect(opened).toMatchObject({
        ok: false,
        laneId: '',
        reason: 'fetch_unreachable',
      });
      expect(findLaneByPacket(packetId)).toBeNull();
      expect(fetchUnreachableCooldownRetrySeconds(repo)).toBeGreaterThan(0);

      const incident = listInboxItems({ includeAllProjects: true })
        .find((item) => item.kind === 'fetch_unreachable' && item.packetId === packetId);
      expect(incident).toMatchObject({
        repoPath: repo,
        packetId,
        kind: 'fetch_unreachable',
        repeatCount: 1,
        status: 'human_required',
        payload: {
          stage: 'pre_lane_receipt',
          baseBranch: 'main',
          branch,
          laneId: null,
          packetId,
          runtime: 'codex',
        },
      });

      const held = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        actor: 'orchestrator',
      });
      expect(held).toMatchObject({ ok: false, laneId: '', reason: 'fetch_unreachable' });
      expect(held.note).toContain('fetch_unreachable cooldown');
      expect(findLaneByPacket(packetId)).toBeNull();
      expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.repeatCount)
        .toBe(1);

      git(repo, ['remote', 'set-url', 'origin', origin]);
      now.mockReturnValue(failedAt + 5 * 60_000 + 1);
      const recovered = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        actor: 'orchestrator',
      });

      expect(recovered.ok).toBe(true);
      expect(findLaneByPacket(packetId)?.id).toBe(recovered.laneId);
      expect(fetchUnreachableCooldownRetrySeconds(repo)).toBeNull();
      expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.status)
        .toBe('self_healed');
    } finally {
      now.mockRestore();
    }
  }, 30_000);

  it('applies the same receipt and cooldown policy before a direct runtime launch', async () => {
    const { repo } = createUnreachableRegisteredRepo('runtime-recovery');
    await addRepo(repo);
    const packetId = `pkt-runtime-fetch-${Date.now()}`;
    const branch = `issue/runtime-fetch-${Date.now()}`;
    const runtime = getRuntime('codex');
    expect(runtime).toBeDefined();
    const launch = vi.spyOn(runtime!, 'launch').mockResolvedValue({
      ok: true,
      note: 'launched',
      sessionKey: 'codex-owned:fetch-recovery-test',
    });

    const request = {
      runtime: 'codex' as const,
      prompt: 'test direct runtime recovery',
      repoPath: repo,
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
    };

    try {
      await expect(launchRuntimeSurface(request)).rejects.toThrow('fetch origin main failed');
      expect(launch).not.toHaveBeenCalled();
      expect(findLaneByPacket(packetId)).toBeNull();
      expect(listLanes().some((lane) => lane.repoPath === repo && lane.branch === branch)).toBe(false);

      const incident = listInboxItems({ includeAllProjects: true })
        .find((item) => item.kind === 'fetch_unreachable' && item.packetId === packetId);
      expect(incident).toMatchObject({
        repoPath: repo,
        packetId,
        kind: 'fetch_unreachable',
        repeatCount: 1,
        status: 'human_required',
        payload: {
          stage: 'pre_launch_fetch',
          baseBranch: 'main',
          branch,
          laneId: null,
          packetId,
          runtime: 'codex',
        },
      });

      await expect(launchRuntimeSurface(request)).rejects.toThrow('fetch_unreachable cooldown');
      expect(launch).not.toHaveBeenCalled();
      expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.repeatCount)
        .toBe(1);
    } finally {
      launch.mockRestore();
    }
  }, 30_000);

  it('refuses an existing-worktree launch when its pre-launch fetch is unreachable', async () => {
    const { origin, repo } = createUnreachableRegisteredRepo('existing-worktree-recovery');
    git(repo, ['remote', 'set-url', 'origin', origin]);
    await addRepo(repo);
    const packetId = `pkt-existing-worktree-fetch-${Date.now()}`;
    const branch = `issue/existing-worktree-fetch-${Date.now()}`;

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

    const prepared = await prepareLaunchWorktree({
      repoRoot: repo,
      agentType: 'codex',
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      laneId: opened.laneId,
      isolationPreference: 'git-worktree',
    });
    expect(prepared?.worktree.path).toBeTruthy();
    const bound = await dispatch({
      verb: 'bind_worktree',
      laneId: opened.laneId,
      worktreePath: prepared!.worktree.path,
      actor: 'system',
    });
    expect(bound.ok).toBe(true);

    git(repo, ['remote', 'set-url', 'origin', path.join(root, 'existing-worktree-missing-origin.git')]);
    const runtime = getRuntime('codex');
    expect(runtime).toBeDefined();
    const launch = vi.spyOn(runtime!, 'launch').mockResolvedValue({
      ok: true,
      note: 'must not launch',
      sessionKey: 'codex-owned:must-not-exist',
    });
    let restoreRetryClock = () => {};

    try {
      const result = await dispatch({
        verb: 'launch_session',
        laneId: opened.laneId,
        prompt: 'do not launch on a stale base',
        actor: 'orchestrator',
      });

      expect(result).toMatchObject({
        ok: false,
        laneId: opened.laneId,
        reason: 'fetch_unreachable',
      });
      expect(launch).not.toHaveBeenCalled();
      expect(findLaneByPacket(packetId)).toMatchObject({
        id: opened.laneId,
        sessionKey: null,
        status: 'awaiting_input',
      });
      const incident = listInboxItems({ includeAllProjects: true }).find((item) => (
        item.repoPath === repo
        && item.packetId === packetId
        && item.kind === 'fetch_unreachable'
        && item.payload.stage === 'pre_launch_fetch'
      ));
      expect(incident).toMatchObject({
        repoPath: repo,
        packetId,
        kind: 'fetch_unreachable',
        repeatCount: 1,
        status: 'human_required',
        payload: {
          stage: 'pre_launch_fetch',
          laneId: opened.laneId,
          packetId,
          runtime: 'codex',
        },
      });

      const repeated = await dispatch({
        verb: 'launch_session',
        laneId: opened.laneId,
        prompt: 'do not launch on a stale base',
        actor: 'orchestrator',
      });
      expect(repeated.note).toContain('fetch_unreachable cooldown');
      expect(launch).not.toHaveBeenCalled();
      expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.repeatCount)
        .toBe(1);

      git(repo, ['remote', 'set-url', 'origin', origin]);
      const retryAt = Date.now() + 5 * 60_000 + 1;
      const retryClock = vi.spyOn(Date, 'now').mockReturnValue(retryAt);
      restoreRetryClock = () => retryClock.mockRestore();
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      launch.mockImplementationOnce(async () => {
        expect(getLaneEvents(opened.laneId!, 100).some((event) => event.verb === 'worktree_refreshed'))
          .toBe(true);
        expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.status)
          .toBe('self_healed');
        expect(fetchUnreachableCooldownRetrySeconds(repo)).toBeNull();
        return {
          ok: true,
          note: 'launched after refresh',
          sessionKey: 'codex-owned:fetch-recovered',
        };
      });

      const recovered = await dispatch({
        verb: 'launch_session',
        laneId: opened.laneId,
        prompt: 'launch only after the origin recovers',
        actor: 'orchestrator',
      });
      expect(recovered).toMatchObject({
        ok: true,
        laneId: opened.laneId,
      });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(findLaneByPacket(packetId)).toMatchObject({
        id: opened.laneId,
        sessionKey: 'codex-owned:fetch-recovered',
        status: 'running',
      });
      expect(listInboxItems({ includeAllProjects: true }).find((item) => item.id === incident?.id)?.status)
        .toBe('self_healed');

      git(repo, ['remote', 'set-url', 'origin', path.join(root, 'existing-worktree-missing-again.git')]);
      const laterPacketId = `${packetId}-later`;
      const later = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch: `${branch}-later`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId: laterPacketId,
        actor: 'orchestrator',
      });
      expect(later).toMatchObject({
        ok: false,
        reason: 'fetch_unreachable',
      });
      const laterIncident = listInboxItems({ includeAllProjects: true }).find((item) => (
        item.repoPath === repo
        && item.packetId === laterPacketId
        && item.kind === 'fetch_unreachable'
        && item.payload.stage === 'pre_lane_receipt'
      ));
      expect(laterIncident).toMatchObject({
        repoPath: repo,
        packetId: laterPacketId,
        kind: 'fetch_unreachable',
        repeatCount: 1,
        status: 'human_required',
        payload: {
          stage: 'pre_lane_receipt',
          laneId: null,
          packetId: laterPacketId,
          runtime: 'codex',
        },
      });
      expect(laterIncident?.id).not.toBe(incident?.id);
    } finally {
      restoreRetryClock();
      vi.unstubAllGlobals();
      launch.mockRestore();
    }
  }, 30_000);

  it('records one cooldown-protected receipt for each packet in the same repository', async () => {
    const { repo } = createUnreachableRegisteredRepo('distinct-packet-recovery');
    await addRepo(repo);
    const failedAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(failedAt);
    const packetA = `pkt-distinct-fetch-a-${failedAt}`;
    const packetB = `pkt-distinct-fetch-b-${failedAt}`;

    try {
      for (const [packetId, branch] of [
        [packetA, `issue/distinct-fetch-a-${failedAt}`],
        [packetB, `issue/distinct-fetch-b-${failedAt}`],
      ] as const) {
        const result = await dispatch({
          verb: 'open_lane',
          repoPath: repo,
          branch,
          baseBranch: 'main',
          runtime: 'codex',
          packetId,
          actor: 'orchestrator',
        });
        expect(result).toMatchObject({ ok: false, reason: 'fetch_unreachable' });
      }

      const incidents = listInboxItems({ includeAllProjects: true }).filter((item) => (
        item.repoPath === repo && item.kind === 'fetch_unreachable'
      ));
      expect(incidents).toHaveLength(2);
      expect(incidents.map((item) => item.packetId).sort()).toEqual([packetA, packetB].sort());
      expect(incidents.every((item) => (
        item.repeatCount === 1 && item.payload.stage === 'pre_lane_receipt'
      ))).toBe(true);

      const repeated = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch: `issue/distinct-fetch-b-${failedAt}`,
        baseBranch: 'main',
        runtime: 'codex',
        packetId: packetB,
        actor: 'orchestrator',
      });
      expect(repeated.note).toContain('fetch_unreachable cooldown');
      expect(listInboxItems({ includeAllProjects: true }).find((item) => (
        item.repoPath === repo && item.packetId === packetB && item.payload.stage === 'pre_lane_receipt'
      ))?.repeatCount).toBe(1);
    } finally {
      now.mockRestore();
    }
  }, 30_000);

  it('does not let a pre-lane cooldown hide the first pre-launch receipt', async () => {
    const { repo } = createUnreachableRegisteredRepo('cross-stage-recovery');
    await addRepo(repo);
    const failedAt = Date.now();
    const packetId = `pkt-cross-stage-fetch-${failedAt}`;
    const branch = `issue/cross-stage-fetch-${failedAt}`;
    const runtime = getRuntime('codex');
    expect(runtime).toBeDefined();
    const launch = vi.spyOn(runtime!, 'launch').mockResolvedValue({
      ok: true,
      note: 'must not launch',
      sessionKey: 'codex-owned:cross-stage-must-not-exist',
    });

    const request = {
      runtime: 'codex' as const,
      prompt: 'exercise the pre-launch recovery stage',
      repoPath: repo,
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
    };

    try {
      const opened = await dispatch({
        verb: 'open_lane',
        repoPath: repo,
        branch,
        baseBranch: 'main',
        runtime: 'codex',
        packetId,
        actor: 'orchestrator',
      });
      expect(opened).toMatchObject({ ok: false, reason: 'fetch_unreachable' });

      await expect(launchRuntimeSurface(request)).rejects.toThrow('fetch origin main failed');
      expect(launch).not.toHaveBeenCalled();
      const incidents = listInboxItems({ includeAllProjects: true }).filter((item) => (
        item.repoPath === repo && item.packetId === packetId && item.kind === 'fetch_unreachable'
      ));
      expect(incidents).toHaveLength(2);
      expect(incidents.map((item) => item.payload.stage).sort()).toEqual([
        'pre_lane_receipt',
        'pre_launch_fetch',
      ]);
      expect(incidents.every((item) => item.repeatCount === 1)).toBe(true);

      await expect(launchRuntimeSurface(request)).rejects.toThrow('fetch_unreachable cooldown');
      expect(listInboxItems({ includeAllProjects: true }).filter((item) => (
        item.repoPath === repo && item.packetId === packetId && item.kind === 'fetch_unreachable'
      )).every((item) => item.repeatCount === 1)).toBe(true);
    } finally {
      launch.mockRestore();
    }
  }, 30_000);
});
