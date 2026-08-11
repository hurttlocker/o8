import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mission-cost-real-path-'));
const ownedRoot = join(dataDir, 'owned-opencode');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedRoot;

const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createLane, findLaneByPacket, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('mission cost persisted-state path', () => {
  it('keeps a terminal OpenCode worker receipt without reviving it in the active status surfaces', async () => {
    const packetId = 'packet-terminal-cost';
    const sessionKey = 'opencode-owned:terminal-cost';
    const sessionDir = join(ownedRoot, 'terminal-cost');
    const runsDir = join(sessionDir, 'runs');
    const stdoutPath = join(runsDir, 'run.stdout.jsonl');
    const stderrPath = join(runsDir, 'run.stderr.log');
    const now = new Date().toISOString();
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(stdoutPath, `${JSON.stringify({
      type: 'step_finish',
      part: {
        cost: 0.0035,
        tokens: { input: 350, output: 60, cache: { read: 80, write: 10 } },
      },
    })}\n`);
    writeFileSync(stderrPath, '');
    writeFileSync(join(sessionDir, 'session.json'), `${JSON.stringify({
      surfaceId: sessionKey,
      sessionDir,
      cwd: dataDir,
      repoPath: dataDir,
      title: 'terminal cost worker',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'test',
      latestSummary: 'done',
      model: 'opencode/deepseek-v4-flash-free',
      recentRuns: [{
        id: 'run-terminal-cost',
        mode: 'launch',
        prompt: 'test',
        startedAt: now,
        finishedAt: now,
        pid: 1,
        stdoutPath,
        stderrPath,
        outcome: 'finished',
      }],
    }, null, 2)}\n`);

    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/terminal-cost',
      runtime: 'opencode',
      packetId,
      sessionKey,
    });
    setLaneStatus(lane.id, 'completed', 'system', 'completed');
    expect(findLaneByPacket(packetId)).toBeNull();

    const packet = {
      id: packetId,
      referenceLabel: 'PKT-COST',
      title: 'terminal cost receipt',
      summary: 'terminal cost receipt',
      workspaceTargetPath: dataDir,
      branchTarget: lane.branch,
      runtime: 'opencode',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      status: 'released',
      lane: null,
    } satisfies OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-terminal-cost',
      repoPath: dataDir,
      runtime: 'opencode',
      packets: [packet],
    });

    const status = await getMissionStatus({ includeCost: true });

    expect(status.agents).toEqual([]);
    expect(status.packets).toHaveLength(1);
    expect(status.packets[0]?.lane).toBeNull();
    expect('historical' in status).toBe(false);
    expect('cost' in status).toBe(true);
    if (!('cost' in status) || !status.cost) {
      throw new Error('Current mission status did not include the requested cost receipt.');
    }
    expect(Object.keys(status.cost)).toEqual(['totalCostUsd', 'packetCosts', 'tokensByRuntime']);
    expect(status.cost.packetCosts).toEqual([{
      packetId,
      sessionKey,
      runtime: 'opencode',
      model: 'opencode/deepseek-v4-flash-free',
      inputTokens: 350,
      outputTokens: 60,
      totalCostUsd: 0.0035,
      hasTelemetry: true,
    }]);
    expect(status.cost.tokensByRuntime.opencode).toEqual({
      inputTokens: 350,
      outputTokens: 60,
      totalCostUsd: 0.0035,
      packetCount: 1,
    });
  });
});
