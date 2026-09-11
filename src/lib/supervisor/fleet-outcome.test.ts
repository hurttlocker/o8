import { describe, expect, it } from 'vitest';

import { settledCompletionStatus, watchedAgentOutcome } from './fleet-outcome';

describe('settledCompletionStatus', () => {
  it('settles a blocked completion on failed, not on the runtime status', () => {
    expect(settledCompletionStatus(true)).toBe('failed');
    expect(settledCompletionStatus(false)).toBe('finished');
  });
});

describe('watchedAgentOutcome', () => {
  it('counts a blocked-completion agent as failed and never as pending', () => {
    const agent = { completionReported: true, lastStatus: settledCompletionStatus(true) };

    expect(watchedAgentOutcome(agent)).toBe('failed');
  });

  it('counts a clean completion as completed', () => {
    expect(watchedAgentOutcome({ completionReported: true, lastStatus: 'finished' })).toBe('completed');
  });

  it('counts an interrupted agent as failed', () => {
    expect(watchedAgentOutcome({ completionReported: true, lastStatus: 'interrupted' })).toBe('failed');
  });

  it('only counts an agent as pending while its completion is unreported', () => {
    expect(watchedAgentOutcome({ completionReported: false, lastStatus: 'running' })).toBe('pending');
    expect(watchedAgentOutcome({ completionReported: false, lastStatus: 'finished' })).toBe('pending');
  });
});
