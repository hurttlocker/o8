import { describe, expect, it } from 'vitest';
import type { LaneEvent } from '@/lib/lane/types';
import {
  normalizeFleetNarrationEvent,
  type FleetNarrationEvent,
} from './fleet-narration-events';
import {
  decideFleetNarration,
  rankByValuePerVoiceSecond,
  type NarrationFleetAgentState,
} from './narration-policy';
import type { VoiceBudgetState } from './voice-budget';

const NOW = Date.parse('2026-07-24T13:00:00.000Z');

function highBudget(): VoiceBudgetState {
  return {
    limitSeconds: 18_000,
    windowMs: 5 * 60 * 60 * 1_000,
    nowMs: NOW,
    spends: [{ atMs: NOW - 1_000, seconds: 120 }],
  };
}

function laneEvent(
  id: string,
  laneId: string,
  verb: LaneEvent['verb'],
  payload: Record<string, unknown>,
  timestamp: string,
): LaneEvent {
  return { id, laneId, verb, actor: 'system', payload, timestamp };
}

function realisticThreePacketSequence(): FleetNarrationEvent[] {
  return [
    normalizeFleetNarrationEvent({
      source: 'lane-event',
      event: laneEvent(
        'evt-review',
        'lane-review',
        'status_change',
        { status: 'reviewing' },
        '2026-07-24T12:00:00.000Z',
      ),
      lane: {
        id: 'lane-review',
        label: 'Checkout packet',
        packetId: 'pkt-review',
        runtime: 'codex',
        sessionKey: 'codex-owned:review',
        status: 'reviewing',
        lastEventLabel: 'review_ready',
        outcome: null,
      },
      packet: null,
      agent: null,
    }),
    normalizeFleetNarrationEvent({
      source: 'lane-event',
      event: laneEvent(
        'evt-retry',
        'lane-retry',
        'typecheck_auto_retry',
        { note: 'Typecheck failed; retrying once.' },
        '2026-07-24T12:00:01.000Z',
      ),
      lane: {
        id: 'lane-retry',
        label: 'Types packet',
        packetId: 'pkt-retry',
        runtime: 'claude-code',
        sessionKey: 'claude-code:retry',
        status: 'reviewing',
        lastEventLabel: 'typecheck_auto_retry',
        outcome: null,
      },
      packet: null,
      agent: null,
    }),
    normalizeFleetNarrationEvent({
      source: 'agent-lifecycle',
      timestamp: '2026-07-24T12:00:02.000Z',
      previousStatus: 'idle',
      agent: {
        id: 'agent-progress',
        name: 'Mobile packet',
        runtime: 'gemini',
        sessionKey: 'gemini-owned:progress',
        status: 'running',
        currentTask: 'Updating the mobile inbox',
        orchestrationPacket: {
          packetId: 'pkt-progress',
          referenceLabel: '#1602',
          title: 'Mobile packet',
          status: 'running',
          runtime: 'gemini',
        },
      },
    }),
  ];
}

const threeAgents: NarrationFleetAgentState[] = [
  { id: 'agent-review', status: 'reviewing' },
  { id: 'agent-retry', status: 'running' },
  { id: 'agent-progress', status: 'running' },
];

describe('fleet narration policy', () => {
  it('interrupts review attention, holds a retry delta, and keeps progress on demand', () => {
    const result = decideFleetNarration({
      events: realisticThreePacketSequence(),
      fleet: { agents: threeAgents },
      budget: highBudget(),
    });

    expect(result.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentLabel: 'Checkout packet',
        tier: 'interrupt-now',
        action: 'speak',
        holdUntilPause: false,
      }),
      expect.objectContaining({
        agentLabel: 'Types packet',
        tier: 'ambient-rollup',
        action: 'hold',
        holdUntilPause: true,
      }),
      expect.objectContaining({
        agentLabel: 'Mobile packet',
        tier: 'on-demand',
        action: 'suppress',
        suppressionReason: 'on-demand-only',
      }),
    ]));

    const ranked = rankByValuePerVoiceSecond(result.decisions);
    expect(ranked[0].tier).toBe('interrupt-now');
    expect(ranked.every((decision) => decision.estimatedVoiceSeconds > 0)).toBe(true);
  });

  it('degrades a seven-agent fleet to exceptions plus one ask-me pointer', () => {
    const agents: NarrationFleetAgentState[] = Array.from(
      { length: 7 },
      (_, index) => ({ id: `agent-${index}`, status: 'running' }),
    );
    const result = decideFleetNarration({
      events: realisticThreePacketSequence(),
      fleet: { agents },
      budget: highBudget(),
    });

    expect(result.exceptionsOnly).toBe(true);
    expect(result.decisions.find((decision) => decision.tier === 'interrupt-now')?.action).toBe('speak');
    expect(result.decisions.find((decision) => decision.agentLabel === 'Types packet')).toMatchObject({
      action: 'suppress',
      suppressionReason: 'concurrency-ceiling',
    });
    const pointers = result.decisions.filter((decision) => decision.isFleetPointer);
    expect(pointers).toHaveLength(1);
    expect(pointers[0].utterance).toContain('ask me about the rest');
  });

  it('suppresses every non-interrupt decision when voice time is low', () => {
    const result = decideFleetNarration({
      events: realisticThreePacketSequence(),
      fleet: { agents: threeAgents },
      budget: {
        limitSeconds: 100,
        windowMs: 5 * 60 * 60 * 1_000,
        nowMs: NOW,
        spends: [{ atMs: NOW - 1_000, seconds: 95 }],
      },
    });

    const interrupt = result.decisions.find((decision) => decision.tier === 'interrupt-now');
    const nonInterrupt = result.decisions.filter((decision) => decision.tier !== 'interrupt-now');
    expect(interrupt?.action).toBe('speak');
    expect(nonInterrupt.every((decision) => (
      decision.action === 'suppress' && decision.suppressionReason === 'low-budget'
    ))).toBe(true);
  });

  it('narrates transitions once and suppresses repeated same-state events', () => {
    const first = decideFleetNarration({
      events: [realisticThreePacketSequence()[0]],
      fleet: { agents: threeAgents },
      budget: highBudget(),
    });
    const repeated = {
      ...realisticThreePacketSequence()[0],
      id: 'evt-review-repeat',
      occurredAt: '2026-07-24T12:05:00.000Z',
    };
    const second = decideFleetNarration({
      events: [repeated],
      fleet: { agents: threeAgents },
      budget: highBudget(),
      memory: first.nextMemory,
    });

    expect(first.decisions[0].action).toBe('speak');
    expect(second.decisions).toHaveLength(1);
    expect(second.decisions[0]).toMatchObject({
      action: 'suppress',
      suppressionReason: 'duplicate-state',
    });
  });
});
