import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-huddle-zero-diff-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { dispatch } = await import('@/lib/lane/commands');
const { reportAgentEvent } = await import('@/lib/lane/agent-report');
const { createLane, getLane, listLanes } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { HUDDLE_READY_EVENT_LABEL } = await import('@/lib/orchestrator/huddle-zero-diff');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

afterAll(() => {
  rmSync(process.env.CORTEX_IDE_DATA_DIR as string, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeCleanWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-huddle-zero-diff-wt-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

function packetFor(worktreePath: string, laneId: string): OrchestratorPacket {
  return {
    id: 'pkt-huddle-zero-diff',
    referenceLabel: 'P1',
    title: 'Plan before editing',
    summary: 'Huddle turn should not produce a diff.',
    workspaceTargetPath: worktreePath,
    branchTarget: 'pkt/huddle-zero-diff',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: {
      tileId: laneId,
      tabId: laneId,
      repoPath: worktreePath,
      worktreePath,
      runtime: 'codex',
      sessionKey: 'codex-owned:huddle-zero-diff',
      laneId,
      lastHeartbeatAt: null,
      lastEventAt: null,
      lastEventLabel: null,
    },
    huddle: true,
  };
}

describe('huddle zero-diff classification', () => {
  it('parks a huddle-armed lane with a persisted huddle report instead of failing zero-diff', async () => {
    const worktreePath = makeCleanWorktree();
    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/huddle-zero-diff',
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey: 'codex-owned:huddle-zero-diff',
      packetId: 'pkt-huddle-zero-diff',
    });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-huddle-zero-diff',
      repoPath: worktreePath,
      runtime: 'codex',
      packets: [packetFor(worktreePath, lane.id)],
      updatedAt: new Date().toISOString(),
    });

    const report = reportAgentEvent({
      laneId: lane.id,
      actor: 'system',
      event: 'huddle',
      message: 'Implementation plan: inspect the classifier, patch the chokepoint, add regression coverage.',
    });
    expect(report?.statusChanged).toBe(true);

    const result = await dispatch({
      verb: 'request_review',
      laneId: lane.id,
      actor: 'system',
    });

    expect(result.ok).toBe(false);
    expect(result.note).toBe(HUDDLE_READY_EVENT_LABEL);

    const parkedLane = getLane(lane.id);
    expect(parkedLane?.status).toBe('awaiting_orchestrator');
    expect(parkedLane?.lastEventLabel).toBe(HUDDLE_READY_EVENT_LABEL);

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === 'pkt-huddle-zero-diff');
    expect(packet?.status).toBe('blocked');
    expect(packet?.blockedReason).toBe(HUDDLE_READY_EVENT_LABEL);
    expect(packet?.lastEventLabel).toBe(HUDDLE_READY_EVENT_LABEL);
    expect(packet?.status).not.toBe('failed');
    expect(listLanes()).toHaveLength(1);
  });
});
