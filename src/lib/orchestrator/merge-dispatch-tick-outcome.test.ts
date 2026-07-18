/**
 * Adversarial F3 — the dispatch tick's outcome must merge per changed packet,
 * never whole-state-overwrite. A locked write that lands while the tick is
 * doing its seconds of worktree/session work has to survive.
 */
import { describe, expect, it } from 'vitest';

import { mergeDispatchTickOutcome } from '@/lib/orchestrator/scheduling';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

function packet(id: string, overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: id,
    summary: '',
    workspaceTargetPath: null,
    branchTarget: `issue/${id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    orchestratorThreadId: null,
    ...overrides,
  };
}

function missionState(packets: OrchestratorPacket[]): OrchestratorMissionState {
  return {
    missionId: 'mission-f3',
    repoPath: null,
    packets,
    updatedAt: '2026-07-18T00:00:00.000Z',
  } as OrchestratorMissionState;
}

describe('mergeDispatchTickOutcome (F3)', () => {
  it('keeps a concurrent write to an untouched packet, applies the tick change, and adds tick-created packets', () => {
    const tickBase = missionState([packet('pkt-a'), packet('pkt-b')]);
    // The tick launched pkt-a and fanned out a sibling.
    const afterDispatch = missionState([
      packet('pkt-a', { status: 'launching' }),
      packet('pkt-b'),
      packet('pkt-fanout'),
    ]);
    // Meanwhile a locked write reviewed pkt-b.
    const fresh = missionState([
      packet('pkt-a'),
      packet('pkt-b', { status: 'awaiting_review', lastEventLabel: 'landed_mid_tick' }),
    ]);

    mergeDispatchTickOutcome(fresh, tickBase, afterDispatch);

    expect(fresh.packets.find((entry) => entry.id === 'pkt-a')?.status).toBe('launching');
    // The old whole-state write would have reverted this to 'queued'.
    expect(fresh.packets.find((entry) => entry.id === 'pkt-b')?.status).toBe('awaiting_review');
    expect(fresh.packets.find((entry) => entry.id === 'pkt-b')?.lastEventLabel).toBe('landed_mid_tick');
    expect(fresh.packets.some((entry) => entry.id === 'pkt-fanout')).toBe(true);
  });
});
