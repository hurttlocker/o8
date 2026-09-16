/**
 * #2351 — a delegated packet must survive a stale dashboard mission write.
 *
 * Observed shape: inside one orchestrator turn the delegate route persisted a
 * new packet, a sibling lane failed, and the dashboard's lane-reconcile effect
 * POSTed its cached mission (read before the delegation) to
 * `/api/orchestrator/state`. That whole-snapshot merge kept only the packets
 * the cache listed, so the delegated packet was erased from durable state: the
 * launch was refused as "not found in durable state" and close_packet_unmerged
 * later reported the packet missing.
 *
 * This drives the REAL delegate route. Lane commands are replaced only at the
 * two verbs the route calls: `open_lane` interleaves the stale client POST
 * through the REAL state route after the delegate persisted its packet, and
 * `launch_session` runs the REAL launch work-mode resolver. The close check
 * goes through the REAL discard-packet route.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  staleClientMission: null as OrchestratorMissionState | null,
  launchRefusal: null as string | null,
  laneIds: new Map<string, string>(),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-delegate-stale-client-'));
const token = 'delegate-stale-client-operator-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
  requestRealtimeRefresh: vi.fn(),
}));
vi.mock('@/lib/runtime/inventory', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/inventory')>(),
  getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [], runtimes: [] })),
}));
vi.mock('@/lib/lane/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/commands')>();
  return {
    ...actual,
    dispatch: vi.fn(async (command: { verb: string; packetId?: string; laneId?: string; repoPath?: string; branch?: string }) => {
      if (command.verb === 'open_lane') {
        // The sibling lane failed; the dashboard reconciles and POSTs the
        // mission it cached before this delegation.
        const { POST } = await import('@/app/api/orchestrator/state/route');
        const response = await POST(request('/api/orchestrator/state', { mission: h.staleClientMission }));
        if (response.status !== 200) throw new Error(`stale client POST failed: ${response.status}`);
        const { createLane } = await import('@/lib/lane/registry');
        const lane = createLane({
          repoPath: command.repoPath!, branch: command.branch!, runtime: 'codex', packetId: command.packetId!,
        });
        h.laneIds.set(lane.id, command.packetId!);
        return { ok: true, laneId: lane.id, note: 'opened' };
      }
      if (command.verb === 'launch_session') {
        const { resolveLaunchWorkMode } = await import('@/lib/runtime/launch-work-mode');
        const resolution = resolveLaunchWorkMode({
          runtime: 'codex',
          packetId: h.laneIds.get(command.laneId!),
        });
        if (!resolution.ok) {
          h.launchRefusal = resolution.reason;
          return { ok: false, laneId: command.laneId, note: resolution.reason };
        }
        return { ok: true, laneId: command.laneId, note: 'launched', lane: { sessionKey: `codex-owned:${command.laneId}`, worktreePath: null } };
      }
      return actual.dispatch(command as Parameters<typeof actual.dispatch>[0]);
    }),
  };
});

function request(pathname: string, body: unknown) {
  return new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const { POST: delegatePost } = await import('@/app/api/orchestrator/delegate/route');
const { POST: statePost } = await import('@/app/api/orchestrator/state/route');
const { POST: discardPost } = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb } = await import('@/lib/db');
const { resolvePacketWorkMode } = await import('@/lib/orchestrator/packet-launch-context');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { removedOrchestratorPacketIds } = await import('@/lib/orchestrator/client-mission-removals');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function packet(id: string): OrchestratorPacket {
  return {
    id, referenceLabel: id, title: id, summary: 'fixture',
    workspaceTargetPath: dataDir, branchTarget: `packet/${id}`, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running', blockedReason: null, lane: null, review: null,
  };
}

function seedMission() {
  return writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'delegate-stale-client',
    repoPath: dataDir,
    packets: [packet('sibling')],
  });
}

describe('delegated packet vs. a stale dashboard mission write (#2351)', () => {
  it('keeps the delegated packet durable for launch and close when a sibling-failure snapshot lands mid-turn', { timeout: 30_000 }, async () => {
    const cached = seedMission();
    h.staleClientMission = {
      ...cached,
      packets: cached.packets.map((entry) => ({ ...entry, status: 'failed', blockedReason: 'worktree provisioning failed' })),
    };

    const response = await delegatePost(request('/api/orchestrator/delegate', {
      prompt: 'Inspect the fixture repository.',
      repoPath: dataDir,
      taskName: 'stale client race',
      runtime: 'codex',
      clientMutationId: 'delegate-stale-client-1',
    }));
    const body = await response.json() as { ok?: boolean; packetId?: string; error?: string };

    expect(h.launchRefusal).toBeNull();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const packetId = body.packetId!;
    expect(resolvePacketWorkMode(packetId)).toMatchObject({ found: true, workMode: 'edit' });
    // The sibling's client-side status still merged.
    expect(readOrchestratorControlPlaneState().packets.find((entry) => entry.id === 'sibling')?.blockedReason)
      .toBe('worktree provisioning failed');

    const close = await discardPost(request('/api/orchestrator/discard-packet', {
      packetId,
      disposition: 'wontfix',
      acknowledgeMissingWorktree: true,
      clientMutationId: 'delegate-stale-client-close-1',
    }));
    const closeBody = await close.json() as Record<string, unknown>;
    expect(close.status, JSON.stringify(closeBody)).toBe(200);
    expect(resolvePacketWorkMode(packetId).found).toBe(true);
    expect(readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId))
      .toMatchObject({ status: 'archived', operatorStopped: true });
  });

  it('still removes a packet the client explicitly deleted', async () => {
    const cached = writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'delegate-stale-client-delete',
      repoPath: dataDir,
      packets: [packet('keep'), packet('drop')],
    });
    const edited = { ...cached, packets: [cached.packets[0]] };
    const removedPacketIds = removedOrchestratorPacketIds(cached, edited);
    expect(removedPacketIds).toEqual(['drop']);
    const response = await statePost(request('/api/orchestrator/state', { mission: edited, removedPacketIds }));
    expect(response.status).toBe(200);
    expect(readOrchestratorControlPlaneState().packets.map((entry) => entry.id)).toEqual(['keep']);
  });
});
