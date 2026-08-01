/**
 * Best-of-N fan-out. The backbone shipped dormant — the
 * fan-out had no production trigger until `comparisonModels` was threaded through
 * create_mission — so this pins the pure state transform that arms it: one seed
 * packet → N sibling candidates, each its own worktree/lane, through a shared
 * comparison group. Catches branch/id-suffix collisions + the idempotence guard.
 */
import { describe, expect, it } from 'vitest';

import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { fanOutComparisonPackets } from '@/lib/orchestrator/comparison-fanout';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function stateWithSeed(overrides: Partial<OrchestratorPacket>) {
  const base = createEmptyOrchestratorMissionState();
  return normalizeOrchestratorMissionState({
    ...base,
    packets: [
      {
        id: 'pkt-seed',
        referenceLabel: 'PKT-1',
        title: 'Add dark mode',
        summary: '',
        status: 'queued',
        queueState: 'queued',
        releaseState: 'pending',
        branchTarget: 'pkt-seed-branch',
        lane: null,
        review: null,
        ...overrides,
      },
    ],
  });
}

describe('best-of-N fan-out', () => {
  it('splits a seed packet with comparisonModels into N sibling candidates', () => {
    const out = fanOutComparisonPackets(stateWithSeed({ comparisonModels: ['codex', 'gemini', 'claude-code'] }));

    expect(out.packets).toHaveLength(3);

    // One shared, non-empty comparison group across all siblings.
    const groupIds = new Set(out.packets.map((p) => p.comparisonGroupId));
    expect(groupIds.size).toBe(1);
    const groupId = [...groupIds][0];
    expect(groupId).toBeTruthy();
    expect(out.activeComparisonGroups).toContain(groupId);

    // One sibling per model, in order, with distinct suffixed id + branch.
    expect(out.packets.map((p) => p.assignedModel)).toEqual(['codex', 'gemini', 'claude-code']);
    expect(out.packets.map((p) => p.comparisonIndex)).toEqual([0, 1, 2]);
    expect(out.packets.map((p) => p.id)).toEqual(['pkt-seed-cmp-0', 'pkt-seed-cmp-1', 'pkt-seed-cmp-2']);
    expect(out.packets.map((p) => p.branchTarget)).toEqual([
      'pkt-seed-branch-cmp-0',
      'pkt-seed-branch-cmp-1',
      'pkt-seed-branch-cmp-2',
    ]);

    // Siblings are fresh lanes and the seed's comparisonModels is consumed (so the
    // tick is idempotent — no re-fan on the next pass).
    expect(out.packets.every((p) => p.lane === null)).toBe(true);
    expect(out.packets.every((p) => !p.comparisonModels || p.comparisonModels.length === 0)).toBe(true);
  });

  it('races N attempts of one model (same-model best-of-N) with distinct lanes', () => {
    const out = fanOutComparisonPackets(stateWithSeed({ comparisonModels: ['codex', 'codex', 'codex'] }));

    expect(out.packets).toHaveLength(3);
    expect(out.packets.map((p) => p.assignedModel)).toEqual(['codex', 'codex', 'codex']);
    expect(new Set(out.packets.map((p) => p.id)).size).toBe(3);
    expect(new Set(out.packets.map((p) => p.branchTarget)).size).toBe(3);
  });

  it('is a no-op (same reference) for a packet without comparisonModels', () => {
    const state = stateWithSeed({});
    const out = fanOutComparisonPackets(state);
    expect(out).toBe(state);
    expect(out.packets).toHaveLength(1);
  });

  it('does not re-fan a packet that already belongs to a comparison group', () => {
    const state = stateWithSeed({ comparisonModels: ['codex', 'codex'], comparisonGroupId: 'cmp-existing' });
    const out = fanOutComparisonPackets(state);
    expect(out).toBe(state);
    expect(out.packets).toHaveLength(1);
  });
});
