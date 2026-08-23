import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    archiveLaneSessionsConfirmed: vi.fn(async () => ({
      targeted: 0, archived: 0, outcomes: [], failures: [],
    })),
    killLaneSessionsConfirmed: vi.fn(async () => []),
  };
});

vi.mock('@/lib/lane/durable-review-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/durable-review-approval')>();
  return {
    ...actual,
    supersedeDurableApprovedReviews: vi.fn(async () => {
      throw new Error('stop after prior generation retirement');
    }),
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-rerun-release-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-rerun-repo-'));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
execFileSync('git', ['-c', 'user.email=test@o8.local', '-c', 'user.name=o8-test',
  'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: repoPath });
const operatorToken = 'operator-storage-rerun-release-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const rerunRoute = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('storage reservation release through rerun retirement', () => {
  it('releases a lane-owned reservation through the persisted rerun route after packetId is cleared', async () => {
    const mission = await createMission({
      issues: [{ number: 1, title: 'inline: rerun release', body: 'rerun release', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const packetId = mission.packets[0]!.id;
    const lane = createLane({
      repoPath,
      branch: 'inline/rerun-release',
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId)!;
      packet.status = 'running';
      packet.queueState = 'queued';
      packet.lane = {
        tileId: 'tile-rerun-release', tabId: 'tab-rerun-release', repoPath,
        worktreePath: null, runtime: 'codex', laneId: lane.id, sessionKey: null,
        lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null,
      };
    });
    const now = Date.now();
    const observation: StorageVolumeObservation = {
      status: 'observed', targetPath: repoPath, probePath: repoPath,
      volumeId: 'device:rerun-release', availableBytes: 10_000,
      freeBytes: 10_000, totalBytes: 20_000, observedAt: now, error: null,
    };
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async () => observation,
    });
    const reservationId = `packet-storage:${lane.id}:1`;
    await store.reserve({
      mutationId: 'reserve-rerun-release', reservationId, targetPath: repoPath,
      exactBytes: 2_000, ownerId: lane.id, ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });

    const response = await rerunRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/rerun-with-feedback',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001', authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId, feedback: 'retry through the persisted route',
          idempotencyKey: 'storage-rerun-release',
        }),
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'rerun_failed' },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived', packetId: '', outcome: 'discarded',
      outcomeNote: 'Superseded by rerun',
    });
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });
});
