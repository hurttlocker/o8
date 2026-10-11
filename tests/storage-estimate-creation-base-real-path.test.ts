import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/worktree/safety-hooks', async (original) => ({
  ...await original<typeof import('@/lib/worktree/safety-hooks')>(),
  writeManagedWorkspaceSafetyHooks: vi.fn(async () => {}),
}));
vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: {
    repoPath: string; projectRepoPath: string; branchName: string; baseBranch: string;
    existingLaneId: string; packetId: string; storageAdmissionReservationId: string;
  }) => {
    const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const prepared = await prepareLaunchWorktree({
      repoRoot: input.projectRepoPath, agentType: 'codex', taskName: input.packetId,
      branchName: input.branchName, baseBranch: input.baseBranch, isolate: true,
      skipSetup: true, packetId: input.packetId, laneId: input.existingLaneId,
      storageAdmissionReservationId: input.storageAdmissionReservationId,
      isolationPreference: 'git-worktree',
    });
    return { ok: true, surfaceId: `codex-owned:${input.packetId}`, note: 'fixture provider',
      worktree: { path: prepared!.worktree.path } };
  }),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-storage-creation-base-'));
const worktreeRoot = join(root, 'worktrees');
mkdirSync(worktreeRoot);
process.env.O8_WORKTREE_ROOT = worktreeRoot;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { getSqlite } = await import('@/lib/db');
const { getWorktreeManager } = await import('@/lib/worktree');
const { getLane, getLaneEvents, findLaneByPacket } = await import('@/lib/lane/registry');
const { createPacketStorageAdmissionCoordinator } = await import('@/lib/orchestrator/storage-admission');
const { observeRepoStorageEstimate } = await import('@/lib/orchestrator/storage-estimate');
const { createStoragePressureAdmissionCoordinator } = await import('@/lib/orchestrator/storage-pressure-policy');
const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
const { resolveWorkerRouting } = await import('@/lib/agents/routing');
const { persistMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function fixture(label: string): { repo: string; main: string; packet: OrchestratorPacket } {
  const repo = join(root, label);
  mkdirSync(repo);
  git(repo, ['init', '-q', '--initial-branch=main']);
  writeFileSync(join(repo, 'main-only.bin'), Buffer.alloc(4 * 1024 ** 2, 'm'));
  const main = commit(repo);
  git(repo, ['checkout', '-qb', 'feature']);
  rmSync(join(repo, 'main-only.bin'));
  writeFileSync(join(repo, 'feature-only.txt'), 'feature\n');
  commit(repo);
  return { repo, main, packet: {
    id: label, referenceLabel: label, title: label, summary: label,
    workspaceTargetPath: repo, branchTarget: `issue/${label}`, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'queued',
  } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => {
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  rmSync(root, { recursive: true, force: true });
});

describe('dispatch storage estimate creation authority', () => {
  it('reconciles an orphaned preparation before any lane or capacity reservation exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { repo, main, packet } = fixture('orphaned-creation-sha');
    const key = `packet-storage-creation-base:${packet.id}:1`;
    getSqlite().prepare(`INSERT INTO idempotency_keys
      (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
      VALUES (?, 'packet_storage_creation_base', ?, NULL, NULL, ?, ?, ?)`)
      .run(key, packet.id, 'orphaned-preparation', Date.now() - 1000, Date.now() - 1);
    const resolve = vi.spyOn(getWorktreeManager(repo), 'resolveCreationBaseCommit');
    const coordinator = createPacketStorageAdmissionCoordinator();
    const result = await launchPacketWithStorageAdmission({
      packet, allPackets: [packet],
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex', source: 'packet-dispatch' }),
      storageAdmission: createStoragePressureAdmissionCoordinator(coordinator),
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(git(getLane(result.laneId)!.worktreePath!, ['rev-parse', 'HEAD'])).toBe(main);
    const persisted = getSqlite().prepare('SELECT result_json FROM idempotency_keys WHERE key = ?')
      .pluck().get(key) as string;
    expect(JSON.parse(persisted).baseCommit).toBe(main);
    expect(result.storageAdmission.state).toBe('committed');
  });

  it('measures and materializes the same saved default commit despite feature HEAD and a ref race', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { repo, main, packet } = fixture('creation-sha');
    const manager = getWorktreeManager(repo);
    const resolve = vi.spyOn(manager, 'resolveCreationBaseCommit');
    let measuredSha: string | undefined;
    const coordinator = createPacketStorageAdmissionCoordinator({
      observeEstimate: async (target, context) => {
        measuredSha = context?.creationBaseCommit;
        const estimate = await observeRepoStorageEstimate(target, { creationBaseCommit: measuredSha });
        // A concurrent publisher moves main after the estimate. Materialization
        // must consume the receipt's immutable SHA rather than re-read/fetch main.
        git(repo, ['update-ref', 'refs/heads/main', git(repo, ['rev-parse', 'feature'])]);
        return estimate;
      },
    });
    const result = await launchPacketWithStorageAdmission({
      packet, allPackets: [packet],
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex', source: 'packet-dispatch' }),
      storageAdmission: createStoragePressureAdmissionCoordinator(coordinator),
    });
    expect(measuredSha).toBe(main);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result.storageAdmission.estimateBytes).toBeGreaterThan(68 * 1024 ** 2);
    expect(getLaneEvents(result.laneId, 100).find((event) => event.verb === 'open_lane')?.payload)
      .toMatchObject({ baseCommit: main, baseCommitPinned: true });
    const lane = getLane(result.laneId)!;
    expect(git(lane.worktreePath!, ['rev-parse', 'HEAD'])).toBe(main);
    expect(existsSync(join(lane.worktreePath!, 'main-only.bin'))).toBe(true);
    expect(existsSync(join(lane.worktreePath!, 'feature-only.txt'))).toBe(false);
    const row = getSqlite().prepare('SELECT result_json FROM idempotency_keys WHERE key = ?')
      .get(`packet-storage-creation-base:${packet.id}:1`) as { result_json: string };
    expect(JSON.parse(row.result_json).baseCommit).toBe(main);
    resolve.mockRejectedValue(new Error('network is now unavailable'));
    expect((await coordinator.prepareCreationBase!(packet, {
      repoPath: repo, packetId: packet.id, branch: packet.branchTarget,
      baseBranch: 'main', runtime: 'codex',
    })).baseCommit).toBe(main);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('replays a reserved base before lane creation without fetching or choosing a newer ref', async () => {
    const { repo, main, packet } = fixture('reserved-sha');
    const manager = getWorktreeManager(repo);
    const resolve = vi.spyOn(manager, 'resolveCreationBaseCommit');
    const coordinator = createPacketStorageAdmissionCoordinator();
    const input = { repoPath: repo, packetId: packet.id, branch: packet.branchTarget,
      baseBranch: 'main', runtime: 'codex' as const };
    const authority = await coordinator.prepareCreationBase!(packet, input);
    await coordinator.reserveForLaunch(packet, 0, { creationBaseCommit: authority.baseCommit });
    expect(findLaneByPacket(packet.id)).toBeNull();
    resolve.mockRejectedValue(new Error('network is now unavailable'));
    const reopened = createPacketStorageAdmissionCoordinator();
    expect((await reopened.prepareCreationBase!(packet, input)).baseCommit).toBe(main);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('reconciles a confirmed dead expired owner before selecting a fresh creation generation', async () => {
    const { repo, packet } = fixture('expired-reserved-sha');
    const input = { repoPath: repo, packetId: packet.id, branch: packet.branchTarget,
      baseBranch: 'main', runtime: 'codex' as const };
    const coordinator = createPacketStorageAdmissionCoordinator();
    const authority = await coordinator.prepareCreationBase!(packet, input);
    const lease = await coordinator.reserveForLaunch(packet, 0, { creationBaseCommit: authority.baseCommit });
    getSqlite().prepare('INSERT INTO missions (id, repo_path, runtime, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('expired-creation-base-mission', repo, 'codex', 'fixture', Date.now(), Date.now());
    await persistMissionRegistryState({
      ...createEmptyOrchestratorMissionState(), missionId: 'expired-creation-base-mission',
      repoPath: repo, runtime: 'codex',
      packets: [{ ...packet, status: 'failed', storageAdmission: lease.receipt }],
    });
    getSqlite().prepare('UPDATE storage_admission_reservations SET lease_expires_at = ? WHERE reservation_id = ?')
      .run(Date.now() - 1, lease.receipt.reservationId);
    getSqlite().prepare('UPDATE idempotency_keys SET expires_at = ? WHERE key = ?')
      .run(Date.now() - 1, `packet-storage-creation-base:${packet.id}:1`);
    expect(findLaneByPacket(packet.id)).toBeNull();
    const retry = createPacketStorageAdmissionCoordinator();
    const next = await retry.prepareCreationBase!(packet, input);
    const nextLease = await retry.reserveForLaunch(packet, 0, { creationBaseCommit: next.baseCommit });
    expect(nextLease.receipt.ownerGeneration).toBe(2);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE reservation_id = ?')
      .pluck().get(lease.receipt.reservationId)).toBe('reconciled');
  });
});
