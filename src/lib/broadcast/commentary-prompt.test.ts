import { describe, expect, it } from 'vitest';

import { buildBroadcastCommentaryPrompt } from './commentary-prompt';
import type { BroadcastEvent, BroadcastEventKind } from './types';

function event(
  id: string,
  kind: BroadcastEventKind,
  timestamp: string,
  payload: Record<string, unknown>,
): BroadcastEvent {
  return {
    schema: 'o8/broadcast.event/v1',
    id,
    source: 'lane',
    kind,
    laneId: 'lane-specific',
    packetId: 'pkt-1805',
    repo: 'o8',
    actor: 'orchestrator',
    title: `${kind} · Specific Broadcast packet`,
    detail: null,
    payload,
    timestamp,
  };
}

describe('Broadcast commentary prompt', () => {
  it('includes specific merge and review evidence from the redacted projection', () => {
    const prompt = buildBroadcastCommentaryPrompt([
      event('merge-one', 'merge', '2026-08-21T12:00:00.000Z', {
        laneHeadSha: '7b4af0a36ff1',
        commitSubject: 'feat: add Broadcast voice triggers',
        changedFileCount: 25,
      }),
      event('review-one', 'review_verdict', '2026-08-21T12:01:00.000Z', {
        approved: false,
        findings: [{ file: 'src/lib/broadcast/speaker.ts', description: 'Generated commentary can replay once.' }],
      }),
    ]);

    expect(prompt).toContain('"commitSubject":"feat: add Broadcast voice triggers"');
    expect(prompt).toContain('"changedFileCount":25');
    expect(prompt).toContain('"mergeSha":"7b4af0a"');
    expect(prompt).toContain('"approved":false');
    expect(prompt).toContain('"findingsCount":1');
    expect(prompt).toContain('"file":"src/lib/broadcast/speaker.ts"');
    expect(prompt).toContain('"description":"Generated commentary can replay once."');
  });

  it('names the packet and elapsed prior state for a status-only slice', () => {
    const running = event('status-one', 'session_launched', '2026-08-21T12:00:00.000Z', { status: 'running' });
    const awaitingReview = event('status-two', 'packet_failed', '2026-08-21T12:06:30.000Z', { status: 'awaiting_review' });
    const prompt = buildBroadcastCommentaryPrompt([awaitingReview], [running, awaitingReview]);

    expect(prompt).toContain('"packetId":"pkt-1805"');
    expect(prompt).not.toContain('"id":"status-one"');
    expect(prompt).toContain('"previousStatus":"running"');
    expect(prompt).toContain('"elapsedInPreviousStatus":"6m 30s"');
  });

  it('keeps the prompt payload bounded by dropping oldest events whole', () => {
    const oldest = { ...event('oldest', 'progress', '2026-08-21T12:00:00.000Z', {}), detail: `old-${'x'.repeat(5_000)}` };
    const newest = { ...event('newest', 'progress', '2026-08-21T12:01:00.000Z', {}), detail: `new-${'y'.repeat(5_000)}` };
    const prompt = buildBroadcastCommentaryPrompt([oldest, newest]);

    expect(prompt).not.toContain('"id":"oldest"');
    expect(prompt).toContain('"id":"newest"');
    expect(prompt).toContain(newest.detail);
  });
});
