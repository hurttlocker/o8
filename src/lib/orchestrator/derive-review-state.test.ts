import { describe, expect, it } from 'vitest';

import { derivePacketReviewState } from './derive-review-state';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function packet(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-1',
    referenceLabel: 'P1',
    title: 'packet',
    summary: 'packet',
    status: 'awaiting_review',
    queueState: 'queued',
    releaseState: 'pending',
    runtime: 'codex',
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: {
      approved: true,
      findings: [],
      summary: 'Approved',
      recordedAt: '2026-07-07T01:40:00.000Z',
    },
    ...overrides,
  } as OrchestratorPacket;
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane-1',
    repoPath: '/repo',
    branch: 'issue/test',
    baseBranch: 'main',
    status: 'merging',
    runtime: 'codex',
    label: 'packet',
    sessionKey: 'codex-owned:1',
    packetId: 'pkt-1',
    worktreePath: '/repo/worktree',
    writerToken: null,
    ownership: 'owned',
    createdAt: '2026-07-07T01:00:00.000Z',
    updatedAt: '2026-07-07T01:40:31.000Z',
    lastEventAt: '2026-07-07T01:40:31.000Z',
    lastEventLabel: 'merging',
    mergeMode: 'direct',
    mergeModeNote: null,
    ...overrides,
  } as Lane;
}

describe('derivePacketReviewState', () => {
  it('keeps an approved passing verdict ready-to-merge while the lane is merging', () => {
    const result = derivePacketReviewState({
      packet: packet(),
      lane: lane(),
      orchestratorReview: {
        verdict: 'approved',
        ts: '2026-07-07T01:40:00.000Z',
        summary: 'Approved',
      },
      mergeGate: {
        verdict: 'passing',
        ts: '2026-07-07T01:40:31.000Z',
        checks: ['merge-preview'],
      },
    });

    expect(result).toEqual({
      state: 'ready-to-merge',
      stateChangedAt: '2026-07-07T01:40:00.000Z',
    });
  });
});
