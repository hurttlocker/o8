import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attentionEventIsCurrent,
  attentionSubscriptionEnabled,
  isBroadcastQuietTime,
  type BroadcastAttentionPolicySettings,
} from './attention-policy';
import type { BroadcastEvent, BroadcastEventKind } from './types';

const databases: Database.Database[] = [];
const settings: BroadcastAttentionPolicySettings = {
  quietHours: 'on',
  quietStart: '22:00',
  quietEnd: '08:00',
  attention: true,
  approvals: true,
  reviews: true,
  failures: true,
  completions: false,
  calendar: true,
  timeCheckins: true,
};

function event(kind: BroadcastEventKind, overrides: Partial<BroadcastEvent> = {}): BroadcastEvent {
  return {
    schema: 'o8/broadcast.event/v1',
    id: `lane:event-${kind}`,
    source: 'lane',
    kind,
    laneId: 'lane-1',
    packetId: 'packet-1',
    repo: 'o8',
    actor: 'system',
    title: 'Operator attention needed · Memory packet',
    detail: null,
    payload: {},
    timestamp: '2026-08-28T01:00:00.000Z',
    ...overrides,
  };
}

function fixture(): Database.Database {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE lanes (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, lane_id TEXT, packet_id TEXT, status TEXT NOT NULL);
  `);
  return sqlite;
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('Broadcast attention policy', () => {
  it('handles same-day, overnight, disabled, and all-day quiet windows', () => {
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 23, 0), settings)).toBe(true);
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 7, 59), settings)).toBe(true);
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 8, 0), settings)).toBe(false);
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 15, 0), {
      quietHours: 'on', quietStart: '09:00', quietEnd: '17:00',
    })).toBe(true);
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 15, 0), {
      quietHours: 'off', quietStart: '09:00', quietEnd: '17:00',
    })).toBe(false);
    expect(isBroadcastQuietTime(new Date(2026, 7, 28, 15, 0), {
      quietHours: 'on', quietStart: '08:00', quietEnd: '08:00',
    })).toBe(true);
  });

  it('honors each event subscription independently', () => {
    expect(attentionSubscriptionEnabled(event('operator_attention'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('approval'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('review_verdict'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('packet_failed'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('calendar_imminent'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('scheduled_attention'), settings)).toBe(true);
    expect(attentionSubscriptionEnabled(event('merge'), settings)).toBe(false);
    expect(attentionSubscriptionEnabled(event('agent_completed'), settings)).toBe(false);
    expect(attentionSubscriptionEnabled(event('progress'), settings)).toBe(false);
  });

  it('rejects resolved approvals and lanes that stopped waiting before speech', () => {
    const sqlite = fixture();
    sqlite.prepare('INSERT INTO lanes VALUES (?, ?)').run('lane-1', 'awaiting_human');
    sqlite.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?)')
      .run('approval-1', 'lane-1', 'packet-1', 'pending');
    const attention = event('operator_attention');
    const approval = event('approval', { id: 'approval:created:approval-1', source: 'approval' });
    expect(attentionEventIsCurrent(attention, sqlite)).toBe(true);
    expect(attentionEventIsCurrent(approval, sqlite)).toBe(true);

    sqlite.prepare('UPDATE lanes SET status = ? WHERE id = ?').run('running', 'lane-1');
    sqlite.prepare('UPDATE approvals SET status = ? WHERE id = ?').run('approved', 'approval-1');
    expect(attentionEventIsCurrent(attention, sqlite)).toBe(false);
    expect(attentionEventIsCurrent(approval, sqlite)).toBe(false);
  });

  it('drops a calendar event once its start time has passed', () => {
    const sqlite = fixture();
    const imminent = event('calendar_imminent', { payload: { startEpochMs: 2_000 } });
    expect(attentionEventIsCurrent(imminent, sqlite, 1_999)).toBe(true);
    expect(attentionEventIsCurrent(imminent, sqlite, 2_000)).toBe(false);
  });
});
