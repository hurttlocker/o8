import { describe, expect, it } from 'vitest';
import { wasArchivedByOperator } from './archive-summary';
import type { LaneEvent } from './types';

function event(partial: Partial<LaneEvent>): LaneEvent {
  return {
    id: partial.id ?? 'evt',
    laneId: 'lane-1',
    verb: partial.verb ?? 'status_change',
    actor: partial.actor ?? 'system',
    payload: partial.payload ?? {},
    timestamp: partial.timestamp ?? '2026-09-11T00:00:00.000Z',
  };
}

describe('wasArchivedByOperator', () => {
  it('reads the actor off the archiving status change', () => {
    const events = [
      event({ id: 'a', actor: 'orchestrator', payload: { status: 'failed' } }),
      event({ id: 'b', actor: 'user', payload: { status: 'archived' } }),
    ];

    expect(wasArchivedByOperator(events)).toBe(true);
  });

  it('does not claim the headless loop auto-archive as an operator dismissal', () => {
    const events = [
      event({ id: 'a', actor: 'user', payload: { status: 'completed' } }),
      event({ id: 'b', actor: 'system', payload: { status: 'archived' } }),
    ];

    expect(wasArchivedByOperator(events)).toBe(false);
  });

  it('uses the most recent archive transition and ignores unarchived lanes', () => {
    expect(wasArchivedByOperator([
      event({ id: 'a', actor: 'user', payload: { status: 'archived' } }),
      event({ id: 'b', actor: 'system', payload: { status: 'archived' } }),
    ])).toBe(false);
    expect(wasArchivedByOperator([
      event({ id: 'a', actor: 'user', verb: 'update', payload: { label: 'renamed' } }),
    ])).toBe(false);
    expect(wasArchivedByOperator([])).toBe(false);
  });
});
