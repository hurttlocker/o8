import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-contract-cost-'));

vi.mock('@/lib/approvals/store', () => ({
  listApprovalsForContext: () => [],
}));

vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [] }),
}));

vi.mock('@/lib/repos/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/projects')>(),
  getActiveProjectScopeForRepoSync: () => ({ projectId: null }),
}));

vi.mock('@/lib/search/transcripts', () => ({
  syncTranscriptSearchDocument: () => undefined,
}));

const packetId = 'pkt-contract-cost';
const contract = {
  version: 1 as const,
  requirements: [{
    id: 'R1',
    source: 'Record contract cost.',
    expectedBehavior: 'One durable cost event is recorded.',
    productionPath: 'capturePacketCompletionContext -> lane event',
    verification: 'persisted lane event test',
  }],
  smallestRoute: [{
    path: 'src/lib/orchestrator/task-contract-cost.ts',
    requirements: ['R1'],
    reason: 'The completion capture owns this receipt.',
  }],
  exclusions: [],
};

const transcript: RuntimeTranscriptEntry[] = [{
  id: 'user-1',
  role: 'user',
  text: 'Prepare the task contract.',
  timestamp: new Date('2026-08-27T12:00:00.000Z'),
}, {
  id: 'assistant-1',
  role: 'assistant',
  text: `<task-contract>${JSON.stringify(contract)}</task-contract>`,
  timestamp: new Date('2026-08-27T12:00:01.250Z'),
}];

let laneId = '';

describe('task contract cost event', () => {
  beforeAll(async () => {
    const runtime: AgentRuntime = {
      id: 'codex',
      displayName: 'Codex contract cost test',
      capabilities: {
        discover: false,
        readTranscript: true,
        launch: false,
        resume: false,
        interrupt: false,
        reviewDiffs: true,
        costTelemetry: true,
        streaming: false,
      },
      discoverSessions: async () => [],
      readTranscript: async () => transcript,
      launch: async () => ({ ok: false, note: 'not supported' }),
      resume: async () => ({ ok: false, note: 'not supported' }),
      interrupt: async () => ({ ok: false, note: 'not supported' }),
      getChangedFiles: async () => [],
      getTelemetry: async () => ({ inputTokens: 120, outputTokens: 30 }),
    };
    const { registerRuntime } = await import('@/lib/runtimes/registry');
    registerRuntime(runtime);

    const { createLane } = await import('@/lib/lane/registry');
    const lane = createLane({
      repoPath: '/tmp/o8-contract-cost-repo',
      branch: 'test/contract-cost',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex:contract-cost',
    });
    laneId = lane.id;

    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const packet = {
      id: packetId,
      referenceLabel: 'P1',
      title: 'Measure task contract cost',
      summary: 'Record a persisted cost receipt.',
      branchTarget: lane.branch,
      workspaceTargetPath: lane.repoPath,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'running',
      taskContractRequired: true,
    } as unknown as OrchestratorPacket;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-contract-cost',
      repoPath: lane.repoPath,
      packets: [packet],
    });
  });

  it('records one persisted cost event when the contract turn completes', async () => {
    const { capturePacketCompletionContext } = await import('./context-relay');
    await capturePacketCompletionContext(packetId, 'codex:contract-cost');
    await capturePacketCompletionContext(packetId, 'codex:contract-cost');

    const { getLaneEvents } = await import('@/lib/lane/registry');
    const events = getLaneEvents(laneId, 100).filter((event) => event.verb === 'task_contract_cost');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      runtime: 'codex',
      turns: 1,
      inputTokens: 120,
      outputTokens: 30,
      durationMs: 1250,
    });
  });
});
