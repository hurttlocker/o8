import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const {
  approveAndMergePacket,
  submitPacketReview,
} = await import('@/lib/orchestrator/operator-mission-service');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { worktreeRepoKey } = await import('@/lib/worktree/root-layout');

const roots: string[] = [];

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

function packetFixture(packetId: string, canonicalRepo: string, branch: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: 'PKT-CANONICAL-MERGE',
    title: 'publish a relocated packet clone',
    summary: 'Exercise canonical direct-merge publication.',
    status: 'awaiting_review',
    queueState: 'queued',
    releaseState: 'pending',
    workspaceTargetPath: canonicalRepo,
    branchTarget: branch,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: null,
    lastEventAt: null,
    lastEventLabel: null,
  } as OrchestratorPacket;
}

function registerCanonicalRepo(canonicalRepo: string, origin: string): void {
  const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
  writeFileSync(join(dataDir, 'repos.json'), `${JSON.stringify({
    version: 1,
    repos: [{
      id: `repo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: 'canonical',
      localPath: canonicalRepo,
      remoteUrl: origin,
      defaultBranch: 'main',
      isGitRepo: true,
      addedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
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
    }],
  }, null, 2)}\n`);
}

function createRelocatedCloneMission(label: string) {
  const root = mkdtempSync(join(os.tmpdir(), `o8-direct-merge-${label}-`));
  const origin = join(root, 'github-like.git');
  const canonicalRepo = join(root, 'canonical');
  const packetId = `pkt-canonical-${label}-${Date.now()}`;
  const branch = `issue/canonical-${label}-${Date.now()}`;
  roots.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, canonicalRepo], { stdio: 'pipe' });
  git(canonicalRepo, ['checkout', '-b', 'main']);
  git(canonicalRepo, ['config', 'user.name', 'o8-test']);
  git(canonicalRepo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(canonicalRepo, 'base.txt'), 'base\n');
  const baseSha = commitAll(canonicalRepo, 'base');
  git(canonicalRepo, ['push', '-u', 'origin', 'main']);

  const relocatedBase = join(
    process.env.CORTEX_IDE_DATA_DIR!,
    'worktrees',
    worktreeRepoKey(canonicalRepo),
    '.cortex-worktrees',
  );
  mkdirSync(relocatedBase, { recursive: true });
  const packetClone = join(relocatedBase, `packet-${packetId}`);
  execFileSync('git', ['clone', origin, packetClone], { stdio: 'pipe' });
  git(packetClone, ['checkout', '-b', branch, 'origin/main']);
  git(packetClone, ['config', 'user.name', 'o8-test']);
  git(packetClone, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(packetClone, 'feature.txt'), `${label}\n`);
  const packetSha = commitAll(packetClone, `feat: ${label} [via-o8]`);

  registerCanonicalRepo(canonicalRepo, origin);
  const lane = createLane({
    repoPath: packetClone,
    worktreePath: packetClone,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Canonical merge ${label}`,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

  const packet = packetFixture(packetId, canonicalRepo, branch);
  const missionId = `mission-canonical-${label}-${Date.now()}`;
  const mission: OrchestratorMissionState = {
    ...createEmptyOrchestratorMissionState(),
    missionId,
    repoPath: canonicalRepo,
    prompt: 'Canonical direct merge real path',
    summary: 'Canonical direct merge real path',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  };
  recordMission({
    id: missionId,
    repoPath: canonicalRepo,
    runtime: 'codex',
    prompt: mission.prompt,
    summary: mission.summary,
    constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState: mission,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(mission);

  return { baseSha, branch, canonicalRepo, lane, packetClone, packetId, packetSha };
}

async function reviewAndMerge(fixture: ReturnType<typeof createRelocatedCloneMission>) {
  await submitPacketReview({
    packetId: fixture.packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: fixture.packetSha,
  });
  return approveAndMergePacket({
    packetId: fixture.packetId,
    expectedHeadSha: fixture.packetSha,
    actor: 'user',
  });
}

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('direct merge publishes through the canonical mission repository', () => {
  it('lands a relocated full-clone packet commit on canonical main', async () => {
    const fixture = createRelocatedCloneMission('success');
    expect(git(fixture.packetClone, ['remote', 'get-url', 'origin'])).not.toBe(fixture.canonicalRepo);

    const result = await reviewAndMerge(fixture);

    expect(result.merged).toBe(true);
    expect(git(fixture.canonicalRepo, ['merge-base', '--is-ancestor', fixture.packetSha, 'main'])).toBe('');
    expect(git(fixture.canonicalRepo, ['rev-parse', 'main'])).toBe(fixture.packetSha);
  }, 30_000);

  it('blocks and escalates when canonical main loses the candidate after git merge succeeds', async () => {
    const fixture = createRelocatedCloneMission('postcondition');
    const hook = join(fixture.canonicalRepo, '.git', 'hooks', 'post-merge');
    writeFileSync(hook, `#!/bin/sh\ngit reset --hard ${fixture.baseSha} >/dev/null\n`);
    chmodSync(hook, 0o755);

    const result = await reviewAndMerge(fixture);
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === fixture.packetId);

    expect(result).toMatchObject({
      merged: false,
      reason: 'canonical_merge_ancestry_failed',
    });
    expect(getLane(fixture.lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
    });
    expect(getLane(fixture.lane.id)?.outcome).not.toBe('merged');
    expect(packet).toMatchObject({
      status: 'blocked',
      blockedReason: 'canonical_merge_ancestry_failed',
    });
    expect(git(fixture.canonicalRepo, ['rev-parse', 'main'])).toBe(fixture.baseSha);
  }, 30_000);
});
