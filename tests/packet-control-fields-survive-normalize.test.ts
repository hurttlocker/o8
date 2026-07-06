/**
 * Packet fields must survive the normalize round-trip (2026-06-22).
 *
 * normalizePacket() rebuilds every packet from scratch and is the single
 * chokepoint EVERY orchestrator-state read and write funnels through. Any field
 * it forgets to copy is silently dropped on the next round-trip. The fixture
 * below intentionally satisfies Required<OrchestratorPacket> so adding a new
 * packet field forces this test to pin its normalize behavior.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function fullPacketFixture() {
  vi.setSystemTime(NOW);

  const packet = {
    id: 'pkt-control-1',
    referenceLabel: 'P1',
    title: 'Control-field packet',
    summary: 'Full normalize fixture',
    workspaceTargetPath: '/repo/o8',
    branchTarget: 'inline/full-normalize',
    runtime: 'codex',
    dependencyLabels: ['P0'],
    dependencyPacketIds: ['pkt-control-0'],
    queueState: 'queued',
    releaseState: 'pending',
    releaseStatePayload: {
      mergeCommit: 'abc123',
      releasedAt: '2026-01-01T00:01:00.000Z',
      source: 'test',
    },
    status: 'awaiting_review',
    attemptCount: 2,
    maxAttempts: 4,
    recoveryCount: 1,
    lastRecoveryAt: '2026-01-01T00:02:00.000Z',
    typecheckAutoRetries: 1,
    stallRetries: 2,
    launchAttempts: 3,
    operatorStopped: true,
    blockedReason: 'operator_stopped',
    lastEventAt: '2026-01-01T00:03:00.000Z',
    lastEventLabel: 'review_requested',
    archivedAt: '2026-01-01T00:04:00.000Z',
    review: {
      approved: true,
      findings: [{
        file: 'src/example.ts',
        line: 12,
        severity: 'warning',
        description: 'Pinned finding',
        resolution: 'fixed',
        fixSuggestion: 'Keep covered',
      }],
      recordedAt: '2026-01-01T00:05:00.000Z',
      reviewedHeadSha: 'def456',
      summary: 'Looks good',
      auditApprovalId: 'approval-1',
    },
    lane: {
      tileId: 'tile-1',
      tabId: 'tab-1',
      repoPath: '/repo/o8',
      worktreePath: '/repo/o8/.worktrees/pkt-control-1',
      runtime: 'codex',
      sessionKey: 'codex-owned:pkt-control-1',
      laneId: 'lane-1',
      lastHeartbeatAt: '2026-01-01T00:06:00.000Z',
      lastEventAt: '2026-01-01T00:07:00.000Z',
      lastEventLabel: 'review_ready',
      mergeMode: 'pr_only',
      mergeModeNote: 'test note',
    },
    packetType: 'decompose',
    decomposition: {
      targetFile: 'src/large.ts',
      postMergeSha: '789abc',
      lineCount: 801,
    },
    comparisonModels: ['gpt-5.5', 'claude-sonnet'],
    comparisonGroupId: 'cmp-1',
    comparisonIndex: 1,
    assignedModel: 'gpt-5.5',
    predictedFiles: ['src/a.ts', 'src/b.ts'],
    workerIntent: 'reviewer',
    useBrain: true,
    huddle: true,
    workerRouting: resolveWorkerRouting({
      workerIntent: 'reviewer',
      requestedProvider: 'codex',
      requestedRuntime: 'codex',
      requestedModel: 'gpt-5.5',
      requestedEffort: 'high',
      confidence: 'high',
      source: 'orchestrator-state',
    }),
    orchestratorThreadId: 'thoughts-123',
    prompt: 'Implement the thing',
    allowedFiles: ['src/a.ts'],
    learnedRules: ['Preserve fields'],
    issue: {
      number: 123,
      body: 'Issue body',
      url: 'https://example.test/issue/123',
    },
    readBudget: {
      minToolCalls: 2,
      requiredReads: ['src/a.ts', 'src/b.ts'],
      planBeforeWrite: true,
    },
    edgeCaseSites: [{
      location: 'src/a.ts:10',
      description: 'Conditional branch',
      kind: 'conditional',
    }],
  } satisfies Required<OrchestratorPacket>;

  return packet;
}

function stateWithPacket(packet: OrchestratorPacket) {
  const base = createEmptyOrchestratorMissionState();
  return {
    ...base,
    packets: [packet],
  };
}

describe('packet fields survive normalize', () => {
  it('preserves every packet key across a normalize round-trip', () => {
    vi.useFakeTimers();
    try {
      const packet = fullPacketFixture();
      const normalized = normalizeOrchestratorMissionState(stateWithPacket(packet));
      expect(normalized.packets[0]).toEqual(packet);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invent absent optional control fields', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({
      ...fullPacketFixture(),
      operatorStopped: undefined,
      orchestratorThreadId: undefined,
    }));

    expect(normalized.packets[0].operatorStopped).toBeUndefined();
    expect(normalized.packets[0].orchestratorThreadId).toBeUndefined();
  });
});
