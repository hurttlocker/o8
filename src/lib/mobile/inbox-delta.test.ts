import { describe, expect, it } from 'vitest';
import { buildMobileInboxDelta, mobileInboxDeltaChangedEntityCount } from './inbox-delta';
import type { MobileInboxSnapshot } from './types';

function snapshot(overrides: Partial<MobileInboxSnapshot> = {}): MobileInboxSnapshot {
  return {
    generatedAt: '2026-07-09T12:00:00.000Z',
    mode: 'live',
    sourceLabel: 'o8',
    sessions: [],
    fleetSessions: [],
    approvals: [],
    reviewUnits: [],
    items: [],
    summary: { alerts: 0, approvals: 0, reviewItems: 0, activeRuns: 0 },
    ...overrides,
  };
}

describe('mobile inbox delta', () => {
  it('emits only changed entities while preserving authoritative order', () => {
    const firstSession = {
      id: 'session-1',
      name: 'one',
      squadId: 'codex',
      runtime: 'codex',
      model: 'gpt',
      status: 'running',
      currentTask: 'build',
      workspace: '/repo',
      branch: 'one',
      sessionKey: 'session-1',
      approvalStatus: 'none',
      lastEventAt: 'now',
      context: { usedPercent: 0, trend: 'stable' as const },
      alerts: 0,
    };
    const secondSession = { ...firstSession, id: 'session-2', sessionKey: 'session-2', name: 'two' };
    const previous = snapshot({ sessions: [firstSession, secondSession] });
    const next = snapshot({
      generatedAt: '2026-07-09T12:00:01.000Z',
      sessions: [{ ...secondSession, status: 'reviewing' }, firstSession],
    });

    const delta = buildMobileInboxDelta(previous, next, 7, 8);

    expect(delta.baseRevision).toBe(7);
    expect(delta.revision).toBe(8);
    expect(delta.entities.sessions.upserts).toEqual([
      expect.objectContaining({ id: 'session-2', status: 'reviewing' }),
    ]);
    expect(delta.entities.sessions.removals).toEqual([]);
    expect(delta.entities.sessions.order).toEqual(['session-2', 'session-1']);
    expect(mobileInboxDeltaChangedEntityCount(delta)).toBe(1);
  });

  it('emits removals and optional collection checkpoints', () => {
    const previous = snapshot({
      items: [
        {
          id: 'item-1',
          kind: 'alert',
          severity: 'warning',
          title: 'warning',
          detail: 'detail',
          actions: [],
        },
      ],
    });
    const delta = buildMobileInboxDelta(previous, snapshot(), 1, 2);

    expect(delta.entities.items.removals).toEqual(['item-1']);
    expect(delta.entities.items.order).toEqual([]);
    expect(mobileInboxDeltaChangedEntityCount(delta)).toBe(1);
  });
});
