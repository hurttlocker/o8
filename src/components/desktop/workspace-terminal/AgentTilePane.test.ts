import { describe, expect, it } from 'vitest';
import { shouldRefreshAgentTranscript } from './AgentTilePane';

describe('shouldRefreshAgentTranscript', () => {
  it('keeps polling while an agent record exists regardless of steering status', () => {
    expect(shouldRefreshAgentTranscript(true, false)).toBe(true);
  });

  it('keeps polling through the lane-only retirement window', () => {
    expect(shouldRefreshAgentTranscript(false, true)).toBe(true);
  });

  it('stops after both live records disappear', () => {
    expect(shouldRefreshAgentTranscript(false, false)).toBe(false);
  });
});
