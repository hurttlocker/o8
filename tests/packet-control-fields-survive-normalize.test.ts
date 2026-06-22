/**
 * Packet control fields must survive the normalize round-trip (2026-06-22).
 *
 * normalizePacket() rebuilds every packet from scratch and is the single
 * chokepoint EVERY orchestrator-state read and write funnels through. Any field
 * it forgets to copy is silently dropped on the next round-trip. Three control
 * fields live ONLY on the packet (not derivable from lane events), so dropping
 * them is a correctness bug with no symptom until the loop it guards re-appears:
 *
 *   - stallRetries     → the self-review stall cap. Dropped ⇒ counter resets to
 *                        0 every tick ⇒ the cap is never reached ⇒ infinite
 *                        re-dispatch (the exact loop the cap was added to kill).
 *   - operatorStopped  → the manual Stop guard. Dropped ⇒ a stopped packet
 *                        forgets it was stopped on the next state read and the
 *                        scheduler relaunches it.
 *   - typecheckAutoRetries → #1108 layer-1 budget. Also event-derived, but
 *                        persisting it keeps the field honest.
 *
 * This test pins the invariant so a future edit to normalizePacket's return
 * object can't silently re-introduce the drop.
 */
import { describe, expect, it } from 'vitest';

import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function stateWithPacket(overrides: Partial<OrchestratorPacket>) {
  const base = createEmptyOrchestratorMissionState();
  return {
    ...base,
    packets: [
      {
        id: 'pkt-control-1',
        referenceLabel: 'PKT-1',
        title: 'Control-field packet',
        summary: '',
        status: 'blocked',
        queueState: 'held',
        releaseState: 'pending',
        blockedReason: 'operator_stopped',
        lane: null,
        review: null,
        ...overrides,
      },
    ],
  };
}

describe('packet control fields survive normalize', () => {
  it('preserves stallRetries across a normalize round-trip', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({ stallRetries: 2 }));
    expect(normalized.packets[0].stallRetries).toBe(2);
  });

  it('preserves operatorStopped=true across a normalize round-trip', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({ operatorStopped: true }));
    expect(normalized.packets[0].operatorStopped).toBe(true);
  });

  it('preserves typecheckAutoRetries across a normalize round-trip', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({ typecheckAutoRetries: 1 }));
    expect(normalized.packets[0].typecheckAutoRetries).toBe(1);
  });

  it('does not invent operatorStopped when it was never set', () => {
    const normalized = normalizeOrchestratorMissionState(stateWithPacket({}));
    expect(normalized.packets[0].operatorStopped).toBeUndefined();
  });
});
