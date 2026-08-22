import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-review-card-pr-only-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

// These routes resolve the caller's principal from an explicit bearer token —
// loopback location is transport evidence, not identity (src/lib/auth/principal.ts
// is fail-closed by design), so a same-origin test request with no Authorization
// header resolves to 'anonymous' and the route correctly 403s it. Mint an
// operator ws-token the same way tests/principal-authz.test.ts does and present
// it on every request below.
const WS_TOKEN = 'review-card-pr-only-ws-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.WS_TOKEN = WS_TOKEN;

const lanesRoute = await import('@/app/api/lanes/route');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { DOGFOOD_PR_ONLY_NOTE } = await import('@/lib/lane/merge-mode');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function lanesReq() {
  return new NextRequest('http://localhost:3001/api/lanes?active=false', {
    method: 'GET',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WS_TOKEN}` },
  });
}

describe('review card PR-only mode reaches the lane-list route', () => {
  it('stamps PR-only merge policy on real /api/lanes rows before UI actions render', async () => {
    const sentinelPath = join(dataDir, '.dogfood-pr-only');
    rmSync(sentinelPath, { force: true });
    const lane = createLane({
      repoPath: '/tmp/o8-review-card-pr-only-repo',
      branch: 'issue/pr-only-card',
      runtime: 'codex',
      label: 'Review card PR-only lane',
      packetId: 'pkt-review-card-pr-only',
    });

    writeFileSync(sentinelPath, '', 'utf-8');
    try {
      const response = await lanesRoute.GET(lanesReq());
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        lanes?: Array<{ id: string; mergeMode?: string; mergeModeNote?: string | null }>;
      };
      const row = payload.lanes?.find((candidate) => candidate.id === lane.id);

      expect(row).toBeTruthy();
      expect(row?.mergeMode).toBe('pr_only');
      expect(row?.mergeModeNote).toBe(DOGFOOD_PR_ONLY_NOTE);
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });

  it('returns durable outside-launch context for the dashboard split-pane fallback', async () => {
    const packetId = 'pkt-lane-launch-context';
    const lane = createLane({
      repoPath: '/tmp/o8-lane-launch-context-repo',
      branch: 'inline/lane-launch-context',
      runtime: 'opencode',
      label: 'Outside worker lane',
      packetId,
      sessionKey: 'opencode-owned:lane-launch-context',
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      packets: [{
        id: packetId,
        referenceLabel: 'OUTSIDE-1',
        title: 'Outside worker',
        summary: 'Outside worker',
        status: 'running',
        queueState: 'queued',
        releaseState: 'pending',
        runtime: 'opencode',
        wave: 1,
        dependencyPacketIds: [],
        dependencyLabels: [],
        blockedReason: null,
        lane: null,
        review: null,
        workspaceTargetPath: '/tmp/o8-lane-launch-context-repo',
        branchTarget: 'inline/lane-launch-context',
        launchContext: {
          source: 'cli',
          presentation: 'split',
          repoContext: 'transient',
          caller: 'outside terminal',
        },
      } as never],
    });

    const response = await lanesRoute.GET(lanesReq());
    const payload = await response.json() as {
      lanes?: Array<{ id: string; launchContext?: Record<string, unknown> | null }>;
    };

    expect(payload.lanes?.find((candidate) => candidate.id === lane.id)?.launchContext).toEqual({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      caller: 'outside terminal',
    });
  });
});

describe('mission-state lane bindings carry PR-only merge policy (the chat banner path)', () => {
  it('real /api/orchestrator/state GET stamps mergeMode on packet lane bindings', async () => {
    const sentinelPath = join(dataDir, '.dogfood-pr-only');
    writeFileSync(sentinelPath, '', 'utf-8');
    try {
      const stateRoute = await import('@/app/api/orchestrator/state/route');
      const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
      const packetId = 'pkt-state-pr-only-band';
      const lane = createLane({
        repoPath: '/tmp/o8-state-pr-only-repo',
        branch: 'issue/state-pr-only',
        runtime: 'codex',
        label: 'State PR-only lane',
        packetId,
      });

      const get = (): Request => new NextRequest('http://localhost:3001/api/orchestrator/state', {
        method: 'GET',
        headers: { host: 'localhost:3001' },
      });
      const seed = await (await stateRoute.GET(get() as never)).json();
      const mission = seed.mission ?? createEmptyOrchestratorMissionState();
      mission.packets = [
        ...mission.packets,
        {
          id: packetId,
          referenceLabel: 'P-pr-only',
          title: 'State PR-only packet',
          status: 'awaiting_review',
          queueState: 'released',
          releaseState: 'released',
          runtime: 'codex',
          wave: 1,
          blockedBy: [],
          lane: { laneId: lane.id, sessionKey: null },
        },
      ];
      const postRes = await stateRoute.POST(new NextRequest('http://localhost:3001/api/orchestrator/state', {
        method: 'POST',
        headers: { host: 'localhost:3001', 'content-type': 'application/json' },
        body: JSON.stringify({ mission }),
      }) as never);
      expect(postRes.status).toBe(200);

      const json = await (await stateRoute.GET(get() as never)).json();
      const packet = json.mission.packets.find((p: { id: string }) => p.id === packetId);
      expect(packet?.lane?.mergeMode).toBe('pr_only');
      expect(packet?.lane?.mergeModeNote).toBe(DOGFOOD_PR_ONLY_NOTE);
    } finally {
      rmSync(sentinelPath, { force: true });
    }
  });
});
