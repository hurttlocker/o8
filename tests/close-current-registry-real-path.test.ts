import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';

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
process.env.O8_WORKTREE_ROOT = join(dataDir, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(dataDir, 'sessions');
const fakeCodex = join(dataDir, 'fake-codex');
writeFileSync(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.130.0\\n"; exit 0; fi\nexit 17\n', { mode: 0o700 });
process.env.O8_CODEX_BIN = fakeCodex;
const route = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState, normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { addRepo } = await import('@/lib/repos/registry');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
async function fixture(name: string) {
  const root = mkdtempSync(join(dataDir, `${name}-`));
  const repoPath = join(root, 'repo');
  const branch = `issue/${name}`;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main', repoPath);
  writeFileSync(join(repoPath, '.gitignore'), '.cortex-worktrees/\n');
  git('-C', repoPath, 'add', '.gitignore');
  git('-C', repoPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const repo = await addRepo(repoPath);
  const worktreeId = `packet-${name}`;
  const worktreePath = join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  // Own a real registered Git worktree; cleanup must remove it on disk.
  git('-C', repoPath, 'branch', branch);
  git('-C', repoPath, 'worktree', 'add', worktreePath, branch);
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(join(worktreePath, '..'));
  const packetId = `${name}-cmp-0`;
  const surfaceId = 'codex-owned:codex-owned-' + packetId;
  const sessionDir = join(dataDir, 'sessions', 'codex-owned-' + packetId);
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId, packetId, sessionDir, cwd: worktreePath, repoPath: worktreePath, branch,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim(),
    title: 'Current and registry close fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recentRuns: [], runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    latestPrompt: 'Verify close finalization.', latestSummary: 'Persisted idle owned fixture.',
    threadId: '12345678-1234-1234-1234-123456789abc',
    workspaceBinding: { logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id,
      packetId, cwd: worktreePath, version: 1, verifiedAt: new Date().toISOString() },
  };
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(session));
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'codex', baseBranch: 'main', createdAt: Date.now(), claudeManaged: false,
    taskName: name, branchName: branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity, materializationParentIdentity, sessionKey: surfaceId,
  }));
  const missionId = `mission-${name}`;
  const packets = [0, 1].map((index) => {
    const id = `${name}-cmp-${index}`;
    const lane = createLane({ repoPath, branch: index === 0 ? branch : `issue/${name}-sibling`, runtime: 'codex', packetId: id,
      worktreePath: index === 0 ? worktreePath : undefined, sessionKey: index === 0 ? surfaceId : undefined, ownership: 'managed' });
    setLaneStatus(lane.id, 'paused', 'user', 'operator_stopped');
    return {
      id, referenceLabel: `inline-${index}`, title: 'Stopped comparison', summary: 'Reset selected member',
      workspaceTargetPath: repoPath, branchTarget: lane.branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'blocked', blockedReason: 'operator_stopped', operatorStopped: true,
      storageAdmissionEpoch: 1, comparisonGroupId: name, comparisonIndex: index,
      lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, repoPath, worktreePath: lane.worktreePath, runtime: 'codex',
        sessionKey: index === 0 ? surfaceId : null, lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null },
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
    const f = await fixture('close-current-success');
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
    const f = await fixture('close-current-newer');
    h.afterCleanup = async () => {
      await withMissionRegistryState(f.missionId, (state) => {
        state.packets[0].storageAdmissionEpoch = 3;
        state.packets[0].lastEventLabel = 'newer-generation';
        return { state, result: undefined };
      });
    };
    const response = await route.POST(request(f.packetId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'close_failed',
      message: expect.stringContaining('registry state (storage_generation_changed)') } });
    closeDb();
    expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({ storageAdmissionEpoch: 3, lastEventLabel: 'newer-generation', archivedAt: null });
  });
  it('refuses a newer registry generation at admission before removing the workspace', async () => {
    const f = await fixture('close-current-newer-admission');
    await withMissionRegistryState(f.missionId, (state) => {
      state.packets[0].storageAdmissionEpoch = 3;
      return { state, result: undefined };
    });
    const response = await route.POST(request(f.packetId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'packet_state_changed',
      message: expect.stringContaining('storage_generation_changed') } });
    expect(existsSync(f.worktreePath)).toBe(true);
    closeDb();
    expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({ storageAdmissionEpoch: 3, archivedAt: null });
  });
  it.each(['released', 'archived'] as const)('preserves %s registry authority before teardown', async (terminal) => {
    const f = await fixture('close-current-terminal-' + terminal);
    await withMissionRegistryState(f.missionId, (state) => {
      const packet = state.packets[0];
      if (terminal === 'released') {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.repoPath, encoding: 'utf8' }).trim();
        markPacketReleased(packet, { source: 'approve_and_merge', mergeCommit: head });
      } else {
        packet.status = 'archived';
        packet.archivedAt = new Date().toISOString();
      }
      return { state, result: undefined };
    });
    const before = readMissionRegistryEntry(f.missionId, { includeArchived: true })!.mission.packets[0];
    const response = await route.POST(request(f.packetId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'packet_state_changed',
      message: expect.stringContaining('terminal_state_changed') } });
    expect(existsSync(f.worktreePath)).toBe(true);
    closeDb();
    expect(readMissionRegistryEntry(f.missionId, { includeArchived: true })!.mission.packets[0])
      .toEqual({ ...before, workerRouting: { ...before.workerRouting, decidedAt: expect.any(String) } });
  });
  it('preserves a different same-generation registry owner acquired after admission', async () => {
    const f = await fixture('close-current-new-owner');
    h.afterCleanup = async () => {
      await withMissionRegistryState(f.missionId, (state) => {
        state.packets[0].releaseStatePayload = { source: 'operator_stop:newer-registry-owner' };
        state.packets[0].lastEventLabel = 'newer-owner';
        return { state, result: undefined };
      });
    };
    const response = await route.POST(request(f.packetId));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'close_failed',
      message: expect.stringContaining('registry state (lifecycle_guard_changed)') } });
    closeDb();
    expect(readMissionRegistryEntry(f.missionId)!.mission.packets[0]).toMatchObject({
      releaseStatePayload: { source: 'operator_stop:newer-registry-owner' }, lastEventLabel: 'newer-owner', archivedAt: null,
    });
  });
  it('does not acknowledge closure when the final registry write fails after cleanup', async () => {
    const f = await fixture('close-current-db-failure');
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
