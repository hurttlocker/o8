import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  afterRetirement: null as (() => Promise<void>) | null,
  retirementCalls: 0,
}));

// Execute real worktree retirement; insert competing durable writes at the
// async cleanup boundary, before the reset's final hold is persisted.
vi.mock('@/lib/orchestrator/operator-mission-service/reset-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service/reset-cleanup')>();
  return {
    ...actual,
    cleanupResetPacketTargets: vi.fn(async (...args: Parameters<typeof actual.cleanupResetPacketTargets>) => {
      h.retirementCalls += 1;
      const result = await actual.cleanupResetPacketTargets(...args);
      if (h.afterRetirement) await h.afterRetirement();
      return result;
    }),
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reset-current-registry-'));
const token = 'operator-reset-current-registry-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/orchestrator/reset-packet/route');
const stopRoute = await import('@/app/api/orchestrator/stop-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { deriveIdempotencyKey } = await import('@/lib/orchestrator/idempotency-store');
const { readResetRequestJournal } = await import('@/lib/orchestrator/operator-mission-service/reset-recovery-journal');

function fixture(name: string) {
  const root = mkdtempSync(join(dataDir, `${name}-`));
  const repoPath = join(root, 'repo');
  const worktreePath = join(root, 'worktree');
  const branch = `issue/${name}`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main', repoPath);
  git('-C', repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  // Match the independent checkout used by the installed desktop surface.
  // Retirement and branch deletion run through production cleanup.
  git('-C', repoPath, 'branch', branch);
  git('clone', '--no-hardlinks', '--branch', branch, repoPath, worktreePath);
  const missionId = `mission-${name}`;
  const packets = [0, 1].map((index) => {
    const id = `${name}-cmp-${index}`;
    const lane = createLane({ repoPath, branch: index === 0 ? branch : `issue/${name}-sibling`, runtime: 'codex', packetId: id,
      worktreePath: index === 0 ? worktreePath : undefined });
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    return {
      id, referenceLabel: `inline-${index}`, title: 'Stopped comparison', summary: 'Reset selected member',
      workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'blocked', blockedReason: 'operator_stopped', operatorStopped: true,
      storageAdmissionEpoch: 1, comparisonGroupId: name, comparisonIndex: index,
      lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, repoPath, worktreePath: lane.worktreePath, runtime: 'codex',
        sessionKey: null, lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null },
    } as OrchestratorPacket;
  });
  const state = normalizeOrchestratorMissionState({ ...createEmptyOrchestratorMissionState(), missionId, repoPath, packets });
  recordMission({ id: missionId, repoPath, runtime: 'codex', prompt: '', summary: '', constraints: '',
    packetMeta: packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })), missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  return { missionId, packetId: packets[0].id, worktreePath, repoPath, branch };
}

function request(packetId: string, idempotencyKey: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/reset-packet', {
    method: 'POST', headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId, clearWorktree: true, idempotencyKey }),
  });
}

beforeEach(() => { h.afterRetirement = null; h.retirementCalls = 0; });
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('current mission reset durability through the authenticated route', () => {
  it('keeps the selected operator-stop barrier after authenticated Stop background cleanup and database reopen', async () => {
    const f = fixture('stop-current-cleanup');
    const response = await stopRoute.POST(new NextRequest('http://localhost:3001/api/orchestrator/stop-packet', {
      method: 'POST', headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ packetId: f.packetId }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { killConfirmed: true } });
    await vi.waitFor(() => {
      expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({ lane: null, storageAdmissionEpoch: 2 });
    }, { timeout: 10000 });
    expect(existsSync(f.worktreePath)).toBe(false);
    closeDb();
    const durable = readMissionRegistryEntry(f.missionId)!.mission;
    expect(durable.packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held', lane: null });
    expect(readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
    expect(durable.packets[1]).toMatchObject({ operatorStopped: true, queueState: 'held', storageAdmissionEpoch: 1 });
  });

  it('reopens the selected held and unbound packet while preserving newer registry metadata and its stopped sibling', async () => {
    const f = fixture('reset-current-success');
    h.afterRetirement = async () => {
      await withMissionRegistryState(f.missionId, (state) => ({ state: { ...state, constraints: 'concurrent-registry-metadata' }, result: undefined }));
    };
    const response = await route.POST(request(f.packetId, 'reset-current-success'));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { reset: true, worktreePruned: true, branchDeleted: true } });
    expect(existsSync(f.worktreePath)).toBe(false);
    closeDb();
    const durable = readMissionRegistryEntry(f.missionId, { includeArchived: true })!.mission;
    expect(durable.constraints).toBe('concurrent-registry-metadata');
    expect(durable.packets[0]).toMatchObject({ lane: null, queueState: 'held', storageAdmissionEpoch: 2 });
    expect(durable.packets[0].operatorStopped).not.toBe(true);
    expect(durable.packets[1]).toMatchObject({ operatorStopped: true, queueState: 'held', status: 'blocked', storageAdmissionEpoch: 1 });
  });

  it('preserves a newer registry generation instead of applying the old reset finalization', async () => {
    const f = fixture('reset-current-newer');
    h.afterRetirement = async () => {
      await withMissionRegistryState(f.missionId, (state) => {
        state.packets[0].storageAdmissionEpoch = 3;
        state.packets[0].lastEventLabel = 'newer-generation';
        return { state, result: undefined };
      });
    };
    const response = await route.POST(request(f.packetId, 'reset-current-newer'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'reset_state_changed' } });
    closeDb();
    const durable = readMissionRegistryEntry(f.missionId, { includeArchived: true })!.mission;
    expect(durable.packets[0]).toMatchObject({ storageAdmissionEpoch: 3, lastEventLabel: 'newer-generation', operatorStopped: true });
    expect(durable.packets[0].lane).not.toBeNull();
    expect(durable.packets[1].operatorStopped).toBe(true);
  });

  it('journals and replays failure after destructive retirement when the final registry write fails', async () => {
    const f = fixture('reset-current-db-failure');
    const key = 'reset-current-db-failure';
    h.afterRetirement = async () => {
      getSqlite().exec(`CREATE TRIGGER reject_reset_registry BEFORE UPDATE ON missions
        WHEN OLD.id = 'mission-reset-current-db-failure'
        BEGIN SELECT RAISE(ABORT, 'fixture registry unavailable'); END`);
    };
    try {
      const response = await route.POST(request(f.packetId, key));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'reset_failed' } });
      expect(existsSync(f.worktreePath)).toBe(false);
      expect(h.retirementCalls).toBe(1);
      const journalKey = deriveIdempotencyKey({ verb: 'reset_packet', scopeId: f.packetId, clientKey: key,
        body: JSON.stringify({ packetId: f.packetId, clearWorktree: true, reason: undefined }) });
      closeDb();
      expect(readResetRequestJournal(journalKey)).toMatchObject({ status: 'present', entry: { phase: 'completed', receipt: { ok: false, code: 'reset_failed', status: 500 } } });
      expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ operatorStopped: true, queueState: 'held' });
      expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0].operatorStopped).toBe(true);
      const replay = await route.POST(request(f.packetId, key));
      expect(replay.status).toBe(500);
      expect(h.retirementCalls).toBe(1);
    } finally {
      getSqlite().exec('DROP TRIGGER IF EXISTS reject_reset_registry');
    }
  });
});
