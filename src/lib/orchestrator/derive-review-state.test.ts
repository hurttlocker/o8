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
  it('reports a released packet with a rejected review as needs-revision', () => {
    const result = derivePacketReviewState({
      packet: packet({ releaseState: 'released' }),
      lane: lane({ status: 'reviewing', outcome: null }),
      orchestratorReview: {
        verdict: 'rejected',
        ts: '2026-07-07T01:40:00.000Z',
        summary: 'Changes requested',
      },
      mergeGate: {
        verdict: 'failing',
        ts: '2026-07-07T01:40:31.000Z',
        checks: ['merge-preview'],
      },
    });

    expect(result.state).toBe('needs-revision');
  });

  it('keeps an approved passing verdict ready-to-merge while the lane is merging', () => {
    const result = derivePacketReviewState({
      packet: packet({ releaseState: 'released' }),
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

  it('reports a released packet without a review decision as working', () => {
    const result = derivePacketReviewState({
      packet: packet({ releaseState: 'released', review: null }),
      lane: lane({ status: 'reviewing', outcome: null }),
      orchestratorReview: null,
      mergeGate: null,
    });

    expect(result.state).toBe('working');
  });

  it('reports a lane completed with the merged outcome as merged', () => {
    const result = derivePacketReviewState({
      packet: packet({ releaseState: 'pending' }),
      lane: lane({ status: 'completed', outcome: 'merged' }),
      orchestratorReview: null,
      mergeGate: null,
    });

    expect(result.state).toBe('merged');
  });

  it('reports a packet with a merge receipt as merged', () => {
    const result = derivePacketReviewState({
      packet: packet({
        releaseState: 'released',
        releaseStatePayload: { mergeCommit: '0123456789012345678901234567890123456789' },
      }),
      lane: lane({ status: 'reviewing', outcome: null }),
      orchestratorReview: null,
      mergeGate: null,
    });

    expect(result.state).toBe('merged');
  });
});
