import { describe, expect, it } from 'vitest';
import type { LaneEvent } from '@/lib/lane/types';
import { normalizeFleetNarrationEvent } from './fleet-narration-events';

function laneEvent(
  id: string,
  verb: LaneEvent['verb'],
  payload: Record<string, unknown>,
): LaneEvent {
  return {
    id,
    laneId: 'lane-auth',
    verb,
    actor: 'system',
    payload,
    timestamp: '2026-07-24T12:00:00.000Z',
  };
}

describe('fleet narration event normalization', () => {
  it('maps a packet report through the real lane-event shape and uses a human label', () => {
    const event = normalizeFleetNarrationEvent({
      source: 'lane-event',
      event: laneEvent('evt-blocked', 'agent_report', {
        event: 'blocked',
        message: 'Waiting on the auth contract.\nNeeds operator input.',
      }),
      lane: {
        id: 'lane-auth',
        label: 'Auth packet',
        packetId: 'pkt-auth',
        runtime: 'codex',
        sessionKey: 'codex-owned:internal-session-key',
        status: 'awaiting_orchestrator',
        lastEventLabel: 'blocked',
        outcome: null,
      },
      packet: null,
      agent: null,
    });

    expect(event).toMatchObject({
      agentLabel: 'Auth packet',
      kind: 'blocked',
      summary: 'Waiting on the auth contract. Needs operator input.',
      transitionKey: 'pkt-auth',
      transitionState: 'blocked',
    });
    expect(event.agentLabel).not.toContain('codex-owned');
    expect(event.rawRef.source).toBe('lane-event');
  });

  it('maps the exact worker-events row shape and turn-summary rollup', () => {
    const worker = normalizeFleetNarrationEvent({
      source: 'worker-event',
      row: {
        id: 7,
        workerRunId: 'run-7',
        eventType: 'errored',
        payloadJson: JSON.stringify({ message: 'Remote build failed.' }),
        createdAt: '2026-07-24T12:01:00.000Z',
      },
      lane: {
        id: 'lane-remote',
        label: 'Remote build',
        packetId: 'pkt-remote',
        runtime: 'codex',
        sessionKey: null,
        status: 'failed',
        lastEventLabel: 'worker_errored',
        outcome: null,
      },
      packet: null,
      agent: null,
    });
    const rollup = normalizeFleetNarrationEvent({
      source: 'turn-summary',
      timestamp: '2026-07-24T12:02:00.000Z',
      agent: { id: 'agent-mobile', name: 'Mobile packet', runtime: 'codex' },
      laneId: 'lane-mobile',
      packetId: 'pkt-mobile',
      summary: {
        assistantMessageId: 'assistant-1',
        elapsedMs: 12_000,
        toolCount: 3,
        toolNames: ['Read', 'Edit'],
        toolNameTotal: 2,
        filesEditedCount: 2,
        filePaths: ['src/a.ts', 'src/b.ts'],
        tokensUsed: 900,
        repoPath: '/repo',
      },
    });

    expect(worker).toMatchObject({
      kind: 'failure',
      summary: 'Remote build failed.',
      transitionState: 'failure',
    });
    expect(rollup).toMatchObject({
      agentLabel: 'Mobile packet',
      kind: 'changed-files',
      summary: 'Edited 2 files during the turn.',
    });
  });

  it('maps an awaiting-review packet state to an interrupt-worthy semantic delta', () => {
    const event = normalizeFleetNarrationEvent({
      source: 'packet-state',
      timestamp: '2026-07-24T12:03:00.000Z',
      previousStatus: 'running',
      agent: { id: 'agent-review', name: 'Checkout packet', runtime: 'claude-code' },
      packet: {
        id: 'pkt-review',
        referenceLabel: '#1601',
        title: 'Checkout packet',
        status: 'awaiting_review',
        blockedReason: null,
        lastEventLabel: 'review_ready',
        lastEventAt: '2026-07-24T12:03:00.000Z',
        runtime: 'claude-code',
        lane: null,
      },
    });

    expect(event.kind).toBe('review-ready');
    expect(event.transitionState).toBe('review-ready');
    expect(event.isTransition).toBe(true);
    expect(event.summary).toBe('Work is ready and awaiting review.');
  });

  it('marks a same-status packet snapshot as state, not a new transition', () => {
    const event = normalizeFleetNarrationEvent({
      source: 'packet-state',
      timestamp: '2026-07-24T12:04:00.000Z',
      previousStatus: 'running',
      agent: { id: 'agent-progress', name: 'Search packet', runtime: 'codex' },
      packet: {
        id: 'pkt-progress',
        referenceLabel: '#1603',
        title: 'Search packet',
        status: 'running',
        blockedReason: null,
        lastEventLabel: 'editing_search',
        lastEventAt: '2026-07-24T12:04:00.000Z',
        runtime: 'codex',
        lane: null,
      },
    });

    expect(event.isTransition).toBe(false);
  });
});
