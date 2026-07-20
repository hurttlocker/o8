import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-heal-guard-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const launchMock = vi.hoisted(() => ({ calls: [] as Array<{ packetId?: string }> }));
vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launchMock.calls.push({ packetId: input.packetId });
    return { ok: true, surfaceId: `codex-owned:${input.packetId}`, note: 'mock', worktree: { path: input.repoPath } };
  }),
}));

const { createLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { getDispatchBlocker, runDispatchTick } = await import('@/lib/orchestrator/scheduling');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { salvagedWorkBlockReason } = await import('@/lib/supervisor/heal-guard');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-heal-guard-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(dir, 'README.md'), 'heal guard test\n');
  git('add', 'README.md');
  git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init');
  return dir;
}

function packetFixture(repoPath: string, overrides: Partial<OrchestratorPacket>): OrchestratorPacket {
  return {
    id: 'pkt-heal-guard',
    referenceLabel: 'P1',
    title: 'salvaged packet',
    summary: 'salvaged packet',
    status: 'recovering',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    blockedBy: [],
    dependencyPacketIds: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    ...overrides,
  } as OrchestratorPacket;
}

describe('salvaged-work heal guard (#1391) — reviewing lanes are never redispatched', () => {
  it('blocks a recovering packet whose latest lane holds salvaged reviewing work, through the REAL dispatch tick', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/heal-guard',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-heal-guard',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'silent_exit_work_present');

    const packet = packetFixture(repoPath, { status: 'recovering' });
    expect(getDispatchBlocker(packet, [packet])).toMatch(/salvaged work awaits review/);

    const state = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-heal-guard',
      repoPath,
      packets: [packet],
    };
    await runDispatchTick(state);
    expect(launchMock.calls).toHaveLength(0);
  }, 20_000);

  it('does not block once the lane is archived (the legit retry path archives first)', async () => {
    const repoPath = makeRepo();
    const lane = createLane({
      repoPath,
      branch: 'inline/heal-guard-archived',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-heal-guard-archived',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'silent_exit_work_present');
    setLaneStatus(lane.id, 'archived', 'system', 'archived');

    const packet = packetFixture(repoPath, { id: 'pkt-heal-guard-archived', status: 'queued' });
    expect(salvagedWorkBlockReason(packet)).toBeNull();
    expect(getDispatchBlocker(packet, [packet])).toBeNull();
  });

  it('does not auto-redispatch an approved archived_recoverable packet through the real dispatch tick', async () => {
    const repoPath = makeRepo();
    const packetId = 'pkt-heal-guard-recoverable';
    const lane = createLane({
      repoPath,
      branch: 'inline/heal-guard-recoverable',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    updateLane(lane.id, {
      status: 'archived',
      outcome: 'archived_recoverable',
      outcomeNote: 'Reviewed work preserved at preserved/packet-test.',
    });
    const packet = packetFixture(repoPath, {
      id: packetId,
      status: 'recovering',
      review: {
        approved: true,
        findings: [],
        summary: 'Approved.',
        recordedAt: new Date().toISOString(),
      },
    });
    const state = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-heal-guard-recoverable',
      repoPath,
      packets: [packet],
    };

    expect(getDispatchBlocker(packet, [packet])).toMatch(/reviewed recoverable work/);
    await runDispatchTick(state);
    expect(launchMock.calls).toHaveLength(0);
  }, 20_000);
});
