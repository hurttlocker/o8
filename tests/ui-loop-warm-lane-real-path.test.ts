import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  perform: vi.fn(),
}));

vi.mock('@/lib/runtime/actions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime/actions')>(),
  performRuntimeAction: h.perform,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-real-path-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-repo-'));
const otherRepoPath = mkdtempSync(join(os.tmpdir(), 'o8-ui-loop-other-repo-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const lookupRoute = await import('@/app/api/orchestrator/ui-loop/route');
const steerRoute = await import('@/app/api/orchestrator/ui-loop/steer/route');
const { closeDb } = await import('@/lib/db');
const {
  createLane,
  deleteLane,
  getLaneEvents,
} = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} = await import('@/lib/orchestrator/store');

const createdLaneIds: string[] = [];

function packetFixture(input: {
  id: string;
  repoPath: string;
  origin?: 'design-mode';
  terminal?: boolean;
}): OrchestratorPacket {
  return {
    id: input.id,
    referenceLabel: 'P1',
    title: 'Edit the selected element',
    summary: 'Apply the Design Mode element edit.',
    ...(input.origin ? { origin: input.origin } : {}),
    workspaceTargetPath: input.repoPath,
    branchTarget: `feat/${input.id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: input.terminal ? 'held' : 'queued',
    releaseState: 'pending',
    status: input.terminal ? 'archived' : 'running',
    blockedReason: null,
    lastEventAt: '2026-08-28T08:00:00.000Z',
    lastEventLabel: input.terminal ? 'archived' : 'running',
    archivedAt: input.terminal ? '2026-08-28T08:01:00.000Z' : null,
    review: null,
    lane: null,
    issue: { number: 1905, url: 'https://example.invalid/issues/1905' },
  };
}

function persistPackets(packets: OrchestratorPacket[]) {
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-ui-loop-real-path',
    repoPath,
    packets,
    updatedAt: '2026-08-28T08:02:00.000Z',
  });
}

function createWarmLane(packet: OrchestratorPacket) {
  const lane = createLane({
    repoPath: packet.workspaceTargetPath ?? repoPath,
    branch: packet.branchTarget,
    runtime: 'codex',
    packetId: packet.id,
    sessionKey: `test-owned:${packet.id}`,
    label: `warm-${packet.id}`,
  });
  createdLaneIds.push(lane.id);
  return lane;
}

function getRequest(targetRepoPath: string) {
  return new NextRequest(`http://localhost:3001/api/orchestrator/ui-loop?repo=${encodeURIComponent(targetRepoPath)}`);
}

function postRequest(targetRepoPath: string, text: string, previewImageDataUri?: string) {
  return new NextRequest('http://localhost:3001/api/orchestrator/ui-loop/steer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: targetRepoPath, text, previewImageDataUri }),
  });
}

beforeEach(() => {
  h.perform.mockReset();
  h.perform.mockImplementation(async (input: { surfaceId: string }) => ({
    ok: true,
    action: 'steer',
    surfaceId: input.surfaceId,
    sessionKey: input.surfaceId,
    runtime: 'codex',
    status: 'completed',
    note: 'steered',
  }));
  persistPackets([]);
});

afterEach(() => {
  for (const laneId of createdLaneIds.splice(0)) deleteLane(laneId);
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(otherRepoPath, { recursive: true, force: true });
});

describe('Design Mode warm packet lane real path', () => {
  it('finds the persisted packet, steers through the real service, and records the audit event', async () => {
    const packet = packetFixture({ id: 'pkt-design-warm', repoPath, origin: 'design-mode' });
    persistPackets([packet]);
    const lane = createWarmLane(packet);
    const editText = 'Edit the selected browser element.\nElement: <button.primary>\nSelector: #save';

    const lookup = await lookupRoute.GET(getRequest(repoPath));
    expect(lookup.status).toBe(200);
    await expect(lookup.json()).resolves.toMatchObject({
      ok: true,
      result: { packetId: packet.id, laneId: lane.id, label: '#1905' },
    });

    const response = await steerRoute.POST(postRequest(
      repoPath,
      editText,
      'data:image/png;base64,element-crop',
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        kind: 'steered',
        packet: { packetId: packet.id, laneId: lane.id },
        imageForwarded: false,
      },
    });
    expect(h.perform).toHaveBeenCalledWith(expect.objectContaining({
      action: 'steer',
      surfaceId: lane.sessionKey,
      message: expect.stringContaining(editText),
    }));
    expect(h.perform.mock.calls[0]?.[0]?.message).toContain('cannot attach the element crop');
    expect(getLaneEvents(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'ui_loop_steered',
        payload: {
          packetId: packet.id,
          elementSummary: 'Element: <button.primary> · Selector: #save',
        },
      }),
    ]));
  });

  it('returns fallback for a terminal packet and does not steer it', async () => {
    const packet = packetFixture({ id: 'pkt-design-terminal', repoPath, origin: 'design-mode', terminal: true });
    persistPackets([packet]);
    createWarmLane(packet);

    await expect((await lookupRoute.GET(getRequest(repoPath))).json()).resolves.toMatchObject({
      ok: true,
      result: null,
    });
    await expect((await steerRoute.POST(postRequest(repoPath, 'Edit the terminal packet.'))).json())
      .resolves.toMatchObject({
        ok: true,
        result: { kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' },
      });
    expect(h.perform).not.toHaveBeenCalled();
  });

  it('never chooses a Design Mode packet from another repo', async () => {
    const packet = packetFixture({ id: 'pkt-design-other-repo', repoPath: otherRepoPath, origin: 'design-mode' });
    persistPackets([packet]);
    createWarmLane(packet);

    await expect((await lookupRoute.GET(getRequest(repoPath))).json()).resolves.toMatchObject({
      ok: true,
      result: null,
    });
  });

  it('never chooses an untagged packet even when its lane is warm', async () => {
    const packet = packetFixture({ id: 'pkt-untagged-warm', repoPath });
    persistPackets([packet]);
    createWarmLane(packet);

    await expect((await lookupRoute.GET(getRequest(repoPath))).json()).resolves.toMatchObject({
      ok: true,
      result: null,
    });
  });

  it('round-trips the Design Mode origin through packet normalization and persistence', () => {
    const packet = packetFixture({ id: 'pkt-origin-round-trip', repoPath, origin: 'design-mode' });
    const normalized = normalizeOrchestratorMissionState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-origin-round-trip',
      repoPath,
      packets: [packet],
    });
    expect(normalized.packets[0]?.origin).toBe('design-mode');

    writeOrchestratorControlPlaneState(normalized);
    expect(readOrchestratorControlPlaneState().packets[0]?.origin).toBe('design-mode');
  });
});
