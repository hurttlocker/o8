import { describe, expect, it } from 'vitest';
import { shouldApplyAutoRestoreAfterFetch } from './autoRestoreGuard';

describe('orchestrator auto-restore guard', () => {
  it('allows restore when the transcript stayed untouched while history loaded', () => {
    expect(shouldApplyAutoRestoreAfterFetch({
      transcriptTouched: false,
      threadId: null,
    })).toBe(true);
  });

  it('blocks late restore from clobbering a post-relaunch send bubble', () => {
    expect(shouldApplyAutoRestoreAfterFetch({
      transcriptTouched: true,
      threadId: null,
    })).toBe(false);
  });

  it('blocks late restore from rerouting a turn after send minted a thread id', () => {
    expect(shouldApplyAutoRestoreAfterFetch({
      transcriptTouched: false,
      threadId: 'thoughts-live-turn',
    })).toBe(false);
  });
});
