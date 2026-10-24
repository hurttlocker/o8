import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const boundary = vi.hoisted(() => ({
  wedge: false,
  invalidateLane: false,
  humanDecision: false,
  spoofManifestReceipt: false,
  preparedPaths: [] as string[],
  launch: vi.fn(async () => ({ ok: true, sessionKey: 'codex-owned:fixture', note: 'fixture launch' })),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => undefined) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => undefined) }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'launch-provisioning-'));
const repoPath = join(root, 'repo');
vi.stubEnv('O8_WORKTREE_ROOT', join(root, 'worktrees'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
const registry = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getSqlite, closeDb } = await import('@/lib/db');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const statusRoute = await import('@/app/api/orchestrator/status/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

beforeAll(async () => {
  mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'launch provisioning fixture\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '--bare', repoPath, origin], { stdio: 'pipe' });
  git('remote', 'add', 'origin', origin);
  git('fetch', 'origin');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  // Pause at the real manager's last setup boundary, before it publishes ready.
  const prototype = WorktreeManager.prototype as unknown as {
    resetTrackedWorkspaceChanges(path: string): Promise<void>;
  };
  const reset = prototype.resetTrackedWorkspaceChanges;
  vi.spyOn(prototype, 'resetTrackedWorkspaceChanges').mockImplementation(async function (this: typeof prototype, path: string) {
    await reset.call(this, path);
    boundary.preparedPaths.push(path);
    const packetId = control.readOrchestratorControlPlaneState().packets[0]!.id;
    const lane = registry.findLatestLaneByPacket(packetId)!;
    if (boundary.wedge) {
      const { enforceWedgeTimeouts, WEDGE_LAUNCHING_MS } = await import('@/lib/lane/wedge-timeouts');
      enforceWedgeTimeouts(Date.now() + WEDGE_LAUNCHING_MS + 1000);
    }
    if (boundary.invalidateLane) registry.setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'launch_stalled');
    if (boundary.humanDecision) registry.setLaneStatus(lane.id, 'awaiting_human', 'user', 'operator_review');
    if (boundary.spoofManifestReceipt) {
      for (let heartbeat = 0; heartbeat < 501; heartbeat += 1) {
        registry.appendEvent(lane.id, 'worktree_provision_queued', 'system', { packetId, position: 1 });
      }
      registry.appendEvent(lane.id, 'workspace_manifest_applied', 'orchestrator', { state: 'completed' });
    }
  });
  const { getRuntime } = await import('@/lib/runtimes');
  vi.spyOn(getRuntime('codex')!, 'launch').mockImplementation(boundary.launch);
  boundary.launch.mockImplementation(async () => ({ ok: true, sessionKey: 'codex-owned:fixture', note: 'fixture launch' }));
});
afterEach(() => {
  boundary.wedge = false;
  boundary.invalidateLane = false;
  boundary.humanDecision = false;
  boundary.spoofManifestReceipt = false;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function persistMission(id: string) {
  const packet: OrchestratorPacket = {
    id, referenceLabel: 'inline-1', title: id, summary: 'exercise launch provisioning',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
    status: 'queued', blockedReason: null, lane: null,
  };
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, runtime: 'codex', packets: [packet] });
  return packet;
}
async function dispatch(packet: OrchestratorPacket) {
  const response = await dispatchRoute.POST(new NextRequest('http://localhost/api/orchestrator/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ missionId: `mission-${packet.id}`, wait: true }),
  }));
  expect(response.status).toBe(200);
}
async function status(packet: OrchestratorPacket) {
  const response = await statusRoute.GET(new NextRequest(`http://localhost/api/orchestrator/status?missionId=mission-${packet.id}`, { headers: { Authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect(response.status).toBe(200);
  return (await response.json()).result.packets[0] as OrchestratorPacket;
}

describe('launch provisioning through mission HTTP entry points', () => {
  it('finishes the same fresh launch when only its provisioning watchdog has escalated', async () => {
    boundary.wedge = true;
    const packet = persistMission('provisioning-watchdog');
    await dispatch(packet);
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    const failure = registry.getLaneEvents(lane.id, 200).find((event) => event.verb === 'worktree_provision_failed');
    expect(failure?.payload.cause).toBeUndefined();
    expect(lane).toMatchObject({ status: 'running', sessionKey: 'codex-owned:fixture' });
    expect((await status(packet)).status).toBe('running');
    expect(boundary.launch).toHaveBeenCalledTimes(1);
    boundary.wedge = false;
  }, 120_000);

  it('does not let older lane history invalidate a new dispatch attempt', async () => {
    const packet = persistMission('provisioning-history');
    const lane = registry.createLane({ repoPath, branch: packet.branchTarget, packetId: packet.id, runtime: 'codex',
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim() });
    for (let index = 0; index < 501; index += 1) registry.appendEvent(lane.id, 'update', 'system', { priorAttempt: index });
    await dispatch(packet);
    expect(registry.getLane(lane.id)?.status).toBe('running');
    expect((await status(packet)).status).toBe('running');
  }, 120_000);

  it('keeps a human decision final and rolls back preparation without starting a provider', async () => {
    boundary.wedge = true;
    boundary.humanDecision = true;
    const packet = persistMission('provisioning-human-decision');
    const launches = boundary.launch.mock.calls.length;
    await dispatch(packet);
    expect(registry.findLatestLaneByPacket(packet.id)).toMatchObject({ status: 'awaiting_human', lastEventLabel: 'operator_review' });
    expect(boundary.launch).toHaveBeenCalledTimes(launches);
    expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    expect(await status(packet)).toMatchObject({ status: 'blocked', queueState: 'held', blockedReason: expect.stringContaining('exact unbound pre-launch lane') });
  }, 120_000);

  it('rolls back the exact checkout and reservation when provisioning loses its lane', async () => {
    boundary.wedge = false;
    boundary.invalidateLane = true;
    const packet = persistMission('provisioning-refusal');
    await dispatch(packet);
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    expect(lane.status).toBe('failed');
    expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    const polled = await status(packet);
    expect(polled.status).toBe('failed');
    expect(polled.blockedReason).toContain('exact unbound pre-launch lane');
    boundary.invalidateLane = false;
  }, 120_000);

  it('exposes both orchestrator and human escalation on the next status poll from persisted queued state', async () => {
    const packet = persistMission('provisioning-escalation');
    const lane = registry.createLane({ repoPath, branch: packet.branchTarget, packetId: packet.id, runtime: 'codex' });
    for (const state of ['awaiting_orchestrator', 'awaiting_human'] as const) {
      registry.setLaneStatus(lane.id, state, 'system', state === 'awaiting_orchestrator' ? 'launch_stalled' : 'orchestrator_wedge_timeout');
      const polled = await status(packet);
      expect(polled.status).toBe('blocked');
      expect(polled.queueState).toBe('held');
      expect(polled.blockedReason).toContain(state === 'awaiting_orchestrator' ? 'launch_stalled' : 'orchestrator_wedge_timeout');
    }
  });

  it.each(['applied', 'failed', 'skipped', 'watchdog', 'human', 'spoofed'] as const)(
    'preserves launch authority with a manifest outcome: %s', async (outcome) => {
      const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
      const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
      await updateOperatorDefaults({ workspaceManifestPolicy: outcome === 'skipped' ? 'disabled' : 'auto' });
      writeFileSync(join(repoPath, 'o8.workspace.json'), JSON.stringify({
        version: 1,
        setup: outcome === 'failed' ? ['exit 1'] : [],
      }));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
      git('add', 'o8.workspace.json');
      git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', `manifest ${outcome}`);
      git('push', 'origin', 'main');
      boundary.wedge = outcome === 'watchdog' || outcome === 'human';
      boundary.humanDecision = outcome === 'human';
      boundary.spoofManifestReceipt = outcome === 'spoofed';
      const packet = persistMission(`provisioning-manifest-${outcome}`);
      const launches = boundary.launch.mock.calls.length;
      await dispatch(packet);
      const lane = registry.findLatestLaneByPacket(packet.id)!;
      const expectedVerb = outcome === 'failed'
        ? 'workspace_manifest_failed'
        : outcome === 'skipped' ? 'workspace_manifest_skipped' : 'workspace_manifest_applied';
      expect(registry.getLaneEvents(lane.id, 1000)).toContainEqual(expect.objectContaining({
        verb: expectedVerb, actor: 'system',
      }));
      if (outcome === 'human' || outcome === 'spoofed') {
        expect(boundary.launch).toHaveBeenCalledTimes(launches);
        expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
        expect((await status(packet)).blockedReason).toContain('exact unbound pre-launch lane');
        if (outcome === 'human') {
          expect(lane).toMatchObject({ status: 'awaiting_human', lastEventLabel: 'operator_review' });
        }
      } else {
        expect(boundary.launch).toHaveBeenCalledTimes(launches + 1);
        expect(lane).toMatchObject({ status: 'running', sessionKey: 'codex-owned:fixture' });
        expect((await status(packet)).status).toBe('running');
        const receipt = await readWorkspaceManifestReceipt(lane.worktreePath!);
        if (outcome === 'skipped') expect(receipt).toBeNull();
        else expect(receipt).toMatchObject({ state: outcome === 'failed' ? 'failed' : 'completed' });
        registry.setLaneStatus(lane.id, 'failed', 'system', 'fixture complete');
      }
    }, 120_000,
  );
});
