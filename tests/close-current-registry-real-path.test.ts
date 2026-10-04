import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({ afterCleanup: null as (() => Promise<void>) | null }));
vi.mock('@/lib/orchestrator/runtime-worktree-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/runtime-worktree-cleanup')>();
  return { ...actual, runRuntimeAwareWorktreeCleanup: vi.fn(async (...args: Parameters<typeof actual.runRuntimeAwareWorktreeCleanup>) => {
    const result = await actual.runRuntimeAwareWorktreeCleanup(...args);
    if (h.afterCleanup) await h.afterCleanup();
    return result;
  }) };
});
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-close-current-registry-'));
const token = 'operator-close-current-registry-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const route = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
function fixture(name: string) {
  const root = mkdtempSync(join(dataDir, `${name}-`));
  const repoPath = join(root, 'repo');
  const worktreePath = join(repoPath, '.cortex-worktrees', `packet-${name}`);
  const branch = `issue/${name}`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main', repoPath);
  writeFileSync(join(repoPath, '.gitignore'), '.cortex-worktrees/\n');
  git('-C', repoPath, 'add', '.gitignore');
  mkdirSync(join(repoPath, '.cortex-worktrees'));
  git('-C', repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  // Own a real registered Git worktree; cleanup must remove it on disk.
  git('-C', repoPath, 'branch', branch);
  git('-C', repoPath, 'worktree', 'add', worktreePath, branch);
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


function request(packetId: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/discard-packet', {
    method: 'POST', headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId, disposition: 'superseded', clientMutationId: packetId }),
  });
}
beforeEach(() => { h.afterCleanup = null; });
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('current packet close durability through the authenticated route', () => {
  it('reopens the same archived selected packet in both stores and preserves fresh metadata and its held sibling', async () => {
    const f = fixture('close-current-success');
    const sibling = structuredClone(readMissionRegistryEntry(f.missionId)!.mission.packets[1]);
    h.afterCleanup = async () => {
      await withMissionRegistryState(f.missionId, (state) => ({ state: { ...state, constraints: 'fresh-metadata' }, result: undefined }));
    };
    const response = await route.POST(request(f.packetId));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { closed: true, worktreeRemoved: true } });
    expect(existsSync(f.worktreePath)).toBe(false);
    closeDb();
    const current = readOrchestratorControlPlaneState();
    const durable = readMissionRegistryEntry(f.missionId)!.mission;
    expect(durable.constraints).toBe('fresh-metadata');
    expect(durable.packets[0]).toMatchObject({ status: 'archived', lane: null, queueState: 'held', operatorStopped: true, archivedAt: current.packets[0].archivedAt });
    expect(durable.packets[0].archivedAt).toEqual(expect.any(String));
    expect(durable.packets[1]).toMatchObject({ status: 'blocked', queueState: 'held', operatorStopped: true, storageAdmissionEpoch: 1 });
    expect(durable.packets[1]).toEqual({ ...sibling, workerRouting: { ...sibling.workerRouting, decidedAt: expect.any(String) } });
    expect(current.packets[1]).toMatchObject({ status: sibling.status, queueState: sibling.queueState, operatorStopped: true, lane: { laneId: sibling.lane!.laneId } });
  });
  it('refuses finalization against a newer durable generation after actual cleanup', async () => {
    const f = fixture('close-current-newer');
    h.afterCleanup = async () => {
      await withMissionRegistryState(f.missionId, (state) => {
        state.packets[0].storageAdmissionEpoch = 3;
        state.packets[0].lastEventLabel = 'newer-generation';
        return { state, result: undefined };
      });
    };
    const response = await route.POST(request(f.packetId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'close_failed' } });
    closeDb();
    expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({ storageAdmissionEpoch: 3, lastEventLabel: 'newer-generation', archivedAt: null });
  });
  it('does not acknowledge closure when the final registry write fails after cleanup', async () => {
    const f = fixture('close-current-db-failure');
    h.afterCleanup = async () => {
      getSqlite().exec(`CREATE TRIGGER reject_close_registry BEFORE UPDATE ON missions WHEN OLD.id = 'mission-close-current-db-failure'
        BEGIN SELECT RAISE(ABORT, 'fixture registry unavailable'); END`);
    };
    try {
      const response = await route.POST(request(f.packetId));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'close_failed' } });
      expect(existsSync(f.worktreePath)).toBe(false);
      closeDb();
      expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({ status: 'blocked', archivedAt: null, operatorStopped: true });
      expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({ status: 'blocked', archivedAt: null, operatorStopped: true });
    } finally { getSqlite().exec('DROP TRIGGER IF EXISTS reject_close_registry'); }
  });
});
