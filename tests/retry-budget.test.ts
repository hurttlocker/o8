/**
 * Packet-scoped typecheck retry budget (#1108 layer 1).
 *
 * The auto-rerun budget lives on the PACKET, not the lane, because auto-rerun
 * archives the lane — a lane-scoped counter resets on every redispatch and a
 * persistently type-broken packet would loop full Codex workers forever.
 *
 * Invariants under test:
 *   - rerun_with_feedback's field reset PRESERVES typecheckAutoRetries
 *   - everything else about the packet resets to a clean draft
 */
import { describe, expect, it } from 'vitest';

import { resetPacketFields } from '@/lib/orchestrator/operator-mission-service/rerun-with-feedback';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-test-1',
    referenceLabel: 'PKT-1',
    title: 'Test packet',
    summary: 'Fixture',
    status: 'blocked',
    queueState: 'active',
    releaseState: 'released',
    blockedReason: 'typecheck failed',
    lane: null,
    review: null,
    lastEventAt: '2026-06-09T00:00:00.000Z',
    lastEventLabel: 'typecheck_escalated',
    recoveryCount: 2,
    lastRecoveryAt: '2026-06-09T00:00:00.000Z',
    typecheckAutoRetries: 1,
    leaseWaitAutoRetries: 1,
    uiLoopIterations: 4,
    uiLoopStartedAt: '2026-08-28T08:00:00.000Z',
    ...overrides,
  } as OrchestratorPacket;
}

describe('resetPacketFields (rerun_with_feedback)', () => {
  it('preserves the typecheck auto-retry budget across redispatch', () => {
    const packet = packetFixture({ typecheckAutoRetries: 1, leaseWaitAutoRetries: 1 });
    resetPacketFields(packet);
    expect(packet.typecheckAutoRetries).toBe(1);
    expect(packet.leaseWaitAutoRetries).toBe(1);
    expect(packet.uiLoopIterations).toBe(4);
    expect(packet.uiLoopStartedAt).toBe('2026-08-28T08:00:00.000Z');
  });

  it('preserves the spent budget across repeated rerun field resets', () => {
    const packet = packetFixture({ typecheckAutoRetries: 1, recoveryCount: 3 });
    resetPacketFields(packet);
    packet.status = 'blocked';
    packet.queueState = 'queued';
    packet.recoveryCount = 2;
    resetPacketFields(packet);
    expect(packet.typecheckAutoRetries).toBe(1);
    expect(packet.leaseWaitAutoRetries).toBe(1);
    expect(packet.uiLoopIterations).toBe(4);
    expect(packet.uiLoopStartedAt).toBe('2026-08-28T08:00:00.000Z');
    expect(packet.recoveryCount).toBe(0);
  });

  it('still resets the packet to a clean dispatchable draft', () => {
    const packet = packetFixture();
    resetPacketFields(packet);
    expect(packet.status).toBe('draft');
    expect(packet.queueState).toBe('queued');
    expect(packet.releaseState).toBe('pending');
    expect(packet.blockedReason).toBeNull();
    expect(packet.lane).toBeNull();
    expect(packet.review).toBeNull();
    expect(packet.recoveryCount).toBe(0);
  });
});
