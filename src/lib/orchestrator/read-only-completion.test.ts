import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-read-only-completion-'));

const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  captureSettledReadOnlyCompletionContext,
  completeReadOnlyZeroDiffLane,
  READ_ONLY_COMPLETED_EVENT_LABEL,
} = await import('./read-only-completion');
import type { OrchestratorPacket, PacketContext } from './types';

function packet(packetId: string, readOnly: boolean): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: packetId.toUpperCase(),
    title: `packet ${packetId}`,
    summary: `packet ${packetId}`,
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
    workspaceTargetPath: '/tmp/o8-read-only-completion-repo',
    branchTarget: `inline/${packetId}`,
    launchContext: {
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      ...(readOnly ? { workMode: 'read-only' as const } : {}),
    },
  } as OrchestratorPacket;
}

function seed(packetId: string, readOnly: boolean) {
  const lane = createLane({
    repoPath: '/tmp/o8-read-only-completion-repo',
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'opencode',
    packetId,
    sessionKey: `opencode-owned:${packetId}`,
  });
  setLaneStatus(lane.id, 'running', 'system', 'session_running');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    packets: [packet(packetId, readOnly)],
  });
  return getLane(lane.id)!;
}

function completionContext(packetId: string): PacketContext {
  return {
    packetId,
    sessionKey: `opencode-owned:${packetId}`,
    summary: 'The requested behavior is documented by the route and its test.',
    changedFiles: [],
    selfReview: {
      passed: true,
      confidence: 'high',
      summary: 'The read-only investigation is ready for handoff.',
      outcome: 'The production route requires a registered repository.',
      evidence: ['src/app/api/example/route.ts and its real-path test agree.'],
      residual: 'none',
      decision: 'finding_ready',
      recurrenceProtection: 'none',
    },
    completedAt: new Date().toISOString(),
    model: 'opencode',
  };
}

describe('read-only zero-diff completion', () => {
  it('waits for the final self-review when the runtime completion beats transcript persistence', async () => {
    let captures = 0;
    const context = await captureSettledReadOnlyCompletionContext(async () => {
      captures += 1;
      return captures === 1
        ? { ...completionContext('pkt-read-only-race'), selfReview: undefined }
        : completionContext('pkt-read-only-race');
    }, { attempts: 2, settleMs: 0 });

    expect(captures).toBe(2);
    expect(context.selfReview).toMatchObject({
      passed: true,
      decision: 'finding_ready',
    });
  });

  it('releases an explicitly read-only packet instead of failing it', async () => {
    const lane = seed('pkt-read-only', true);

    const result = await completeReadOnlyZeroDiffLane(lane, completionContext('pkt-read-only'));

    expect(result.completed).toBe(true);
    expect(getLane(lane.id)).toMatchObject({
      status: 'completed',
      outcome: 'no_changes',
      lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'released',
      queueState: 'held',
      releaseState: 'released',
      blockedReason: null,
      lastEventLabel: READ_ONLY_COMPLETED_EVENT_LABEL,
    });
  });

  it('fails closed when the read-only transcript has no complete evidence receipt', async () => {
    const lane = seed('pkt-read-only-empty', true);

    const result = await completeReadOnlyZeroDiffLane(lane, {
      ...completionContext('pkt-read-only-empty'),
      selfReview: undefined,
    });

    expect(result).toMatchObject({ completed: false, blocked: true });
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      lastEventLabel: 'read_only_evidence_missing',
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'read_only_evidence_missing',
      lastEventLabel: 'read_only_evidence_missing',
    });
  });

  it('leaves ordinary edit packets on the existing zero-diff path', async () => {
    const lane = seed('pkt-edit', false);

    expect(await completeReadOnlyZeroDiffLane(lane, completionContext('pkt-edit'))).toEqual({ completed: false });
    expect(getLane(lane.id)?.status).toBe('running');
  });
});
