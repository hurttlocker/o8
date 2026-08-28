import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { recordAutomationAttention } from './automation-attention';

const databases: Database.Database[] = [];

function fixture(): Database.Database {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      packet_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

function worker(packetId: string): RequestPrincipalContext {
  return {
    role: 'worker',
    packetId,
    tokenId: 'token-1',
    leaseProcessMarker: null,
    leaseProcessPid: null,
    leaseProcessGroupId: null,
  };
}

const policy = {
  broadcastVoice: 'on' as const,
  broadcastVoiceTimeCheckins: true,
};

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('Scheduled Symon attention', () => {
  it('requires durable automation provenance and deduplicates the source event by packet', () => {
    const sqlite = fixture();
    const now = new Date('2026-08-28T13:00:00.000Z');
    sqlite.prepare('INSERT INTO lanes VALUES (?, ?, ?, ?)').run(
      'lane-automation-1', '[automation] Morning check-in', 'packet-automation-1', now.toISOString(),
    );
    expect(recordAutomationAttention(
      { text: 'Two approvals need you.' },
      worker('packet-automation-1'),
      { sqlite, now, policy },
    ).status).toBe('recorded');
    expect(recordAutomationAttention(
      { text: 'This duplicate text cannot speak twice.' },
      worker('packet-automation-1'),
      { sqlite, now, policy },
    ).status).toBe('duplicate');

    sqlite.prepare('INSERT INTO lanes VALUES (?, ?, ?, ?)').run(
      'lane-automation-2', '[automation] Afternoon check-in', 'packet-automation-2', now.toISOString(),
    );
    expect(recordAutomationAttention(
      { text: 'One review needs you.' },
      worker('packet-automation-2'),
      { sqlite, now, policy },
    ).status).toBe('recorded');

    const row = sqlite.prepare(`
      SELECT text, metadata_json AS metadata FROM broadcast_events
      WHERE packet_id = 'packet-automation-1'
    `).get() as { text: string; metadata: string };
    expect(row.text).toBe('Two approvals need you.');
    expect(JSON.parse(row.metadata)).toMatchObject({
      attentionKind: 'scheduled_attention',
      speechSuppressed: true,
      automationLabel: 'Morning check-in',
    });
  });

  it('rejects a packet that is not owned by the automation scheduler', () => {
    const sqlite = fixture();
    sqlite.prepare('INSERT INTO lanes VALUES (?, ?, ?, ?)').run(
      'lane-worker', 'Ordinary packet', 'packet-worker', new Date().toISOString(),
    );
    expect(() => recordAutomationAttention(
      { text: 'Not authorized.' },
      worker('packet-worker'),
      { sqlite, policy },
    )).toThrow(/Only a durable o8 automation lane/);
  });
});
