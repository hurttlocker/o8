import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV47ExplainerQueueSchema } from './v47-explainer-queue-migration';

describe('v47 explainer queue migration', () => {
  it('creates an independent durable queue with its own budget and telemetry columns', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV47ExplainerQueueSchema(sqlite);
      const columns = (sqlite.prepare('PRAGMA table_info(explainer_queue)').all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining([
        'attempts',
        'contention_count',
        'queue_wait_ms',
        'turn_duration_ms',
        'backend',
        'approximate_cost',
        'outcome',
      ]));
      const indexes = (sqlite.prepare('PRAGMA index_list(explainer_queue)').all() as Array<{ name: string }>)
        .map((index) => index.name);
      expect(indexes).toContain('idx_explainer_queue_packet_status');
    } finally {
      sqlite.close();
    }
  });
});
