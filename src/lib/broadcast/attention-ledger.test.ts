import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { latestBroadcastAttentionReceipt } from './attention-ledger';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('Broadcast attention ledger', () => {
  it('returns only a successfully heard line with its durable policy and sources', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    ensureV44BroadcastSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO broadcast_events
        (id, kind, actor, text, metadata_json, created_at)
      VALUES (?, 'commentary', 'symon', ?, ?, ?)
    `).run(
      'line-unheard',
      'This never reached the speaker.',
      JSON.stringify({ voiceTrigger: 'moment' }),
      '2026-08-28T00:59:00.000Z',
    );
    sqlite.prepare(`
      INSERT INTO broadcast_events
        (id, kind, actor, text, metadata_json, created_at)
      VALUES (?, 'commentary', 'symon', ?, ?, ?)
    `).run(
      'line-heard',
      'The review packet needs you.',
      JSON.stringify({
        voiceTrigger: 'moment',
        speechHeardAt: '2026-08-28T01:00:02.000Z',
        provenance: {
          reason: 'An enabled attention subscription matched a current durable event.',
          sources: [{
            id: 'lane:event-1',
            kind: 'operator_attention',
            title: 'Operator attention needed · Review packet',
            detail: 'Choose whether to rerun.',
            timestamp: '2026-08-28T01:00:00.000Z',
            laneId: 'lane-1',
            packetId: 'packet-1',
          }],
        },
      }),
      '2026-08-28T01:00:01.000Z',
    );

    expect(latestBroadcastAttentionReceipt(sqlite)).toEqual({
      id: 'line-heard',
      utterance: 'The review packet needs you.',
      toldAt: '2026-08-28T01:00:01.000Z',
      heardAt: '2026-08-28T01:00:02.000Z',
      trigger: 'moment',
      reason: 'An enabled attention subscription matched a current durable event.',
      sources: [{
        id: 'lane:event-1',
        kind: 'operator_attention',
        title: 'Operator attention needed · Review packet',
        detail: 'Choose whether to rerun.',
        timestamp: '2026-08-28T01:00:00.000Z',
        laneId: 'lane-1',
        packetId: 'packet-1',
      }],
    });
  });
});
