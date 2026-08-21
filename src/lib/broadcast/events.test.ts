import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV43ResourceLeaseSchema } from '@/lib/db/v43-resource-leases-migration';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { listBroadcastEvents, listRecentBroadcastEvents } from './events';

const openDatabases: Database.Database[] = [];

function fixture(): Database.Database {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      packet_id TEXT,
      repo_path TEXT NOT NULL,
      label TEXT NOT NULL
    );
    CREATE TABLE lane_events (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      verb TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      lane_id TEXT,
      packet_id TEXT,
      title TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE approval_events (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      note TEXT,
      details_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);
  ensureV43ResourceLeaseSchema(sqlite);
  ensureV44BroadcastSchema(sqlite);
  sqlite.prepare('INSERT INTO lanes VALUES (?, ?, ?, ?)')
    .run('lane-one', 'packet-one', '/Users/example/work/o8', 'B1 Broadcast');
  return sqlite;
}

function addLaneEvent(
  sqlite: Database.Database,
  id: string,
  verb: string,
  payload: Record<string, unknown>,
  timestamp: string,
): void {
  sqlite.prepare('INSERT INTO lane_events VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'lane-one', verb, 'orchestrator', JSON.stringify(payload), timestamp);
}

afterEach(() => {
  delete process.env.O8_BROADCAST_TEST_SECRET;
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('Broadcast event projection', () => {
  it('classifies the initial ledger kinds and recursively redacts secrets and home paths', () => {
    const sqlite = fixture();
    process.env.O8_BROADCAST_TEST_SECRET = 'environment-secret-value';
    addLaneEvent(sqlite, 'event-1', 'status_change', { status: 'running', eventLabel: 'session_launched' }, '2026-08-21T12:00:00.000Z');
    addLaneEvent(sqlite, 'event-2', 'agent_report', {
      event: 'progress',
      message: 'working in /Users/example/work/o8 with environment-secret-value and Bearer o8sp_thisisasecretvalue',
      metadata: {
        token: 'do-not-render',
        apiKey: 'also-do-not-render',
        nested: { environmentVariables: { KEY: 'do-not-render' } },
      },
    }, '2026-08-21T12:00:01.000Z');
    addLaneEvent(sqlite, 'event-3', 'message', { message: 'handoff ready' }, '2026-08-21T12:00:02.000Z');
    sqlite.prepare(`
      INSERT INTO resource_lease_events (id, resource, verb, actor, payload_json, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('lease-1', 'repo-tree:/Users/example/work/o8', 'acquired', 'operator', '{}', '2026-08-21T12:00:03.000Z');
    sqlite.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('approval-1', 'lane-one', 'packet-one', 'Merge B1', 'medium', 'pending', Date.parse('2026-08-21T12:00:04.000Z'));
    sqlite.prepare('INSERT INTO approval_events VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('approval-event-1', 'approval-1', 'orchestrator_review', 'orchestrator', 'Approved', '{"approved":true}', Date.parse('2026-08-21T12:00:05.000Z'));

    const page = listBroadcastEvents({ limit: 20 }, sqlite);
    expect(page.events.map((event) => event.kind)).toEqual([
      'session_launched',
      'progress',
      'message',
      'lease_acquired',
      'approval',
      'review_verdict',
    ]);
    expect(page.events.every((event) => event.repo === null || event.repo === 'o8')).toBe(true);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/Users/example');
    expect(serialized).not.toContain('environment-secret-value');
    expect(serialized).not.toContain('do-not-render');
    expect(serialized).not.toContain('o8sp_thisisasecretvalue');
    expect(serialized).toContain('[redacted]');
  });

  it('advances an opaque cursor and applies repo, lane, and kind filters', () => {
    const sqlite = fixture();
    addLaneEvent(sqlite, 'event-1', 'agent_report', { event: 'progress', message: 'first' }, '2026-08-21T12:00:00.000Z');
    const initial = listBroadcastEvents({ repo: 'o8', lane: 'lane-one', kinds: ['progress'] }, sqlite);
    expect(initial.events).toHaveLength(1);
    expect(initial.cursor).toEqual(expect.any(String));

    addLaneEvent(sqlite, 'event-0', 'agent_report', { event: 'progress', message: 'same millisecond' }, '2026-08-21T12:00:00.000Z');
    addLaneEvent(sqlite, 'event-2', 'brain_consulted', { question: 'What changed?' }, '2026-08-21T12:00:01.000Z');
    addLaneEvent(sqlite, 'event-3', 'agent_report', { event: 'progress', message: 'second' }, '2026-08-21T12:00:02.000Z');
    const next = listBroadcastEvents({
      cursor: initial.cursor,
      repo: '/Users/example/work/o8',
      lane: 'lane-one',
      kinds: ['progress'],
    }, sqlite);
    expect(next.events.map((event) => event.detail)).toEqual(['same millisecond', 'second']);
    expect(next.cursor).not.toBe(initial.cursor);
  });

  it('paginates the ledger forward without making older events unreachable', () => {
    const sqlite = fixture();
    addLaneEvent(sqlite, 'event-1', 'agent_report', { event: 'progress', message: 'first' }, '2026-08-21T12:00:00.000Z');
    addLaneEvent(sqlite, 'event-2', 'agent_report', { event: 'progress', message: 'second' }, '2026-08-21T12:00:01.000Z');
    addLaneEvent(sqlite, 'event-3', 'agent_report', { event: 'progress', message: 'third' }, '2026-08-21T12:00:02.000Z');

    const first = listBroadcastEvents({ limit: 2 }, sqlite);
    expect(first.events.map((event) => event.detail)).toEqual(['first', 'second']);
    expect(first.hasMore).toBe(true);

    const second = listBroadcastEvents({ cursor: first.cursor, limit: 2 }, sqlite);
    expect(second.events.map((event) => event.detail)).toEqual(['third']);
    expect(second.hasMore).toBe(false);
  });

  it('tails the last events for a snapshot and hands live polling the head cursor', () => {
    const sqlite = fixture();
    addLaneEvent(sqlite, 'event-1', 'agent_report', { event: 'progress', message: 'first' }, '2026-08-21T12:00:00.000Z');
    addLaneEvent(sqlite, 'event-2', 'agent_report', { event: 'progress', message: 'second' }, '2026-08-21T12:00:01.000Z');
    addLaneEvent(sqlite, 'event-3', 'agent_report', { event: 'progress', message: 'third' }, '2026-08-21T12:00:02.000Z');

    const recent = listRecentBroadcastEvents({ limit: 2 }, sqlite);
    expect(recent.events.map((event) => event.detail)).toEqual(['second', 'third']);
    addLaneEvent(sqlite, 'event-4', 'agent_report', { event: 'progress', message: 'fourth' }, '2026-08-21T12:00:03.000Z');

    const live = listBroadcastEvents({ cursor: recent.cursor }, sqlite);
    expect(live.events.map((event) => event.detail)).toEqual(['fourth']);
  });

  it('fails closed on malformed cursors and unknown kinds', () => {
    const sqlite = fixture();
    const preCommentaryCursor = Buffer.from(JSON.stringify({
      v: 1,
      positions: { lane: 0, lease: 0, approval_create: 0, approval_event: 0 },
    })).toString('base64url');
    expect(() => listBroadcastEvents({ cursor: preCommentaryCursor }, sqlite)).not.toThrow();
    expect(() => listBroadcastEvents({ cursor: 'not-a-cursor' }, sqlite)).toThrow(/cursor is invalid/);
    expect(() => listBroadcastEvents({ kinds: ['uncollected'] }, sqlite)).toThrow(/Unknown Broadcast event kind/);
  });
});
