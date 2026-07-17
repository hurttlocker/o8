import { describe, expect, it } from 'vitest';
import { missionCardBelongsToThread, resolveMissionThreadId } from './mission-complete-detector';

describe('Mission-complete thread ownership', () => {
  it('only matches the exact originating orchestrator thread', () => {
    expect(missionCardBelongsToThread('thoughts-origin', 'thoughts-origin')).toBe(true);
    expect(missionCardBelongsToThread('thoughts-origin', 'thoughts-fresh')).toBe(false);
    expect(missionCardBelongsToThread('thoughts-origin', null)).toBe(false);
    expect(missionCardBelongsToThread(null, 'thoughts-fresh')).toBe(false);
  });

  it('derives one shared packet origin and rejects ambiguous ownership', () => {
    expect(resolveMissionThreadId([
      { orchestratorThreadId: 'thoughts-origin' },
      { orchestratorThreadId: 'thoughts-origin' },
    ])).toBe('thoughts-origin');
    expect(resolveMissionThreadId([
      { orchestratorThreadId: 'thoughts-origin' },
      { orchestratorThreadId: 'thoughts-other' },
    ])).toBeNull();
    expect(resolveMissionThreadId([{ orchestratorThreadId: null }])).toBeNull();
  });
});
