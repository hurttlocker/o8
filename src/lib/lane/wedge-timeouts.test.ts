import { describe, expect, it } from 'vitest';

import { createLane, getLane, getLaneEvents, updateLane } from './registry';
import type { Lane, LaneStatus } from './types';
import {
  WEDGE_AWAITING_ORCHESTRATOR_MS,
  WEDGE_PARKED_REMINDER_MS,
  WEDGE_RECOVERING_MS,
  computeWedgeAction,
  enforceWedgeTimeouts,
} from './wedge-timeouts';

const NOW = Date.parse('2026-07-08T12:00:00.000Z');

function fakeLane(status: LaneStatus, overrides: Partial<Lane> = {}): Lane {
  const base: Lane = {
    id: `lane-fake-${Math.random().toString(36).slice(2, 8)}`,
    projectId: null,
    label: 'fake lane',
    repoPath: '/tmp/o8-wedge-test-repo',
    worktreePath: null,
    branch: 'inline/wedge',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: null,
    packetId: null,
    prNumber: null,
    status,
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date(NOW - 3 * WEDGE_PARKED_REMINDER_MS).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastEventAt: new Date(NOW).toISOString(),
    lastEventLabel: null,
  };
  return { ...base, ...overrides };
}

function agedLane(status: LaneStatus, ageMs: number, overrides: Partial<Lane> = {}): Lane {
  return fakeLane(status, { lastEventAt: new Date(NOW - ageMs).toISOString(), ...overrides });
}

describe('computeWedgeAction (pure decision matrix)', () => {
  it('recovering + packet past 15m escalates to awaiting_orchestrator (no card)', () => {
    const action = computeWedgeAction(agedLane('recovering', WEDGE_RECOVERING_MS + 1_000, { packetId: 'pkt-1' }), NOW);
    expect(action).toMatchObject({
      kind: 'escalate_orchestrator',
      from: 'recovering',
      to: 'awaiting_orchestrator',
      transitions: true,
      raisesCard: false,
      blockedReason: 'recovering_wedge_timeout',
    });
  });

  it('recovering WITHOUT a packet is left alone (phantom → archiver owns it)', () => {
    expect(computeWedgeAction(agedLane('recovering', WEDGE_RECOVERING_MS + 1_000), NOW)).toBeNull();
  });

  it('recovering under 15m does not fire', () => {
    expect(computeWedgeAction(agedLane('recovering', WEDGE_RECOVERING_MS - 1_000, { packetId: 'pkt-1' }), NOW)).toBeNull();
  });

  it('awaiting_orchestrator past 60m escalates to awaiting_input with a human card', () => {
    const action = computeWedgeAction(agedLane('awaiting_orchestrator', WEDGE_AWAITING_ORCHESTRATOR_MS + 1_000), NOW);
    expect(action).toMatchObject({
      kind: 'escalate_human',
      from: 'awaiting_orchestrator',
      to: 'awaiting_input',
      transitions: true,
      raisesCard: true,
    });
  });

  it('awaiting_orchestrator under 60m does not fire', () => {
    expect(computeWedgeAction(agedLane('awaiting_orchestrator', WEDGE_AWAITING_ORCHESTRATOR_MS - 1_000), NOW)).toBeNull();
  });

  it('paused/awaiting_input past 24h raises a reminder but does NOT transition', () => {
    for (const status of ['paused', 'awaiting_input'] as const) {
      const action = computeWedgeAction(agedLane(status, WEDGE_PARKED_REMINDER_MS + 1_000), NOW);
      expect(action).toMatchObject({ kind: 'parked_reminder', from: status, to: status, transitions: false, raisesCard: true });
    }
  });

  it('paused under 24h does not fire', () => {
    expect(computeWedgeAction(agedLane('paused', WEDGE_PARKED_REMINDER_MS - 1_000), NOW)).toBeNull();
  });

  it('active/terminal statuses never wedge', () => {
    for (const status of ['running', 'reviewing', 'merging', 'completed', 'failed', 'archived', 'idle', 'launching'] as const) {
      expect(computeWedgeAction(agedLane(status, WEDGE_PARKED_REMINDER_MS + 1_000, { packetId: 'pkt-x' }), NOW)).toBeNull();
    }
  });
});

// ── Real-path: persist lanes, run the REAL enforcement tick, assert effects ──

function parkLane(status: LaneStatus, ageMs: number, opts: { packetId?: string } = {}): Lane {
  const lane = createLane({
    repoPath: '/tmp/o8-wedge-real-repo',
    branch: `inline/wedge-${Math.random().toString(36).slice(2, 8)}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: opts.packetId,
  });
  // Force it into the parked status with a backdated last-activity timestamp so
  // the wedge clock reads it as long-parked.
  const parked = updateLane(
    lane.id,
    { status, lastEventAt: new Date(NOW - ageMs).toISOString(), lastEventLabel: status },
    'system',
  );
  return parked ?? lane;
}

describe('enforceWedgeTimeouts (real path through the registry)', () => {
  it('escalates a stalled recovering packet lane and emits a wedge_timeout event, edge-triggered', () => {
    const lane = parkLane('recovering', WEDGE_RECOVERING_MS + 60_000, { packetId: 'pkt-wedge-rec' });

    const first = enforceWedgeTimeouts(NOW);
    expect(first.some((o) => o.laneId === lane.id && o.action.kind === 'escalate_orchestrator')).toBe(true);

    const after = getLane(lane.id);
    expect(after?.status).toBe('awaiting_orchestrator');
    const wedgeEvents = getLaneEvents(lane.id, 100).filter((e) => e.verb === 'wedge_timeout');
    expect(wedgeEvents).toHaveLength(1);
    expect(wedgeEvents[0]?.payload).toMatchObject({ from: 'recovering', to: 'awaiting_orchestrator', action: 'escalate_orchestrator' });

    // Edge trigger: a second tick at the SAME instant must not re-fire (the lane
    // already left `recovering`, and even if it hadn't the wedge-event guard holds).
    const second = enforceWedgeTimeouts(NOW);
    expect(second.some((o) => o.laneId === lane.id)).toBe(false);
    expect(getLaneEvents(lane.id, 100).filter((e) => e.verb === 'wedge_timeout')).toHaveLength(1);
  });

  it('escalates a stalled awaiting_orchestrator lane to awaiting_input (human)', () => {
    const lane = parkLane('awaiting_orchestrator', WEDGE_AWAITING_ORCHESTRATOR_MS + 60_000);

    enforceWedgeTimeouts(NOW);

    const after = getLane(lane.id);
    expect(after?.status).toBe('awaiting_input');
    const wedge = getLaneEvents(lane.id, 100).find((e) => e.verb === 'wedge_timeout');
    expect(wedge?.payload).toMatchObject({ from: 'awaiting_orchestrator', to: 'awaiting_input', action: 'escalate_human' });
  });

  it('reminds a 24h-parked awaiting_input lane WITHOUT changing its status, once per episode', () => {
    const lane = parkLane('awaiting_input', WEDGE_PARKED_REMINDER_MS + 60_000);

    const first = enforceWedgeTimeouts(NOW);
    expect(first.some((o) => o.laneId === lane.id && o.action.kind === 'parked_reminder')).toBe(true);
    expect(getLane(lane.id)?.status).toBe('awaiting_input'); // unchanged — legit human wait
    expect(getLaneEvents(lane.id, 100).filter((e) => e.verb === 'wedge_timeout')).toHaveLength(1);

    // Same-episode re-tick must not double-remind (edge trigger on the existing event).
    const second = enforceWedgeTimeouts(NOW);
    expect(second.some((o) => o.laneId === lane.id)).toBe(false);
    expect(getLaneEvents(lane.id, 100).filter((e) => e.verb === 'wedge_timeout')).toHaveLength(1);
  });
});
