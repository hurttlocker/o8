import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { ensureV65OrchestratorLeadSchema } from './v65-orchestrator-lead-migration';

describe('orchestrator lead migration', () => {
  it('creates the replay-safe lifecycle tables idempotently', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureV65OrchestratorLeadSchema(sqlite);
      ensureV65OrchestratorLeadSchema(sqlite);
      const tables = sqlite.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'orchestrator_lead%'
        ORDER BY name
      `).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        'orchestrator_lead_events',
        'orchestrator_lead_turns',
        'orchestrator_leads',
      ]);

      sqlite.prepare(`
        INSERT INTO orchestrator_leads
          (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status, created_at, updated_at)
        VALUES ('lead-1', 'start-1', 'digest-1', 'thoughts-lead-1', '/repo', 'codex', 'gpt-5.6-sol', 'high', 'queued', 1, 1)
      `).run();
      expect(() => sqlite.prepare(`
        INSERT INTO orchestrator_leads
          (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status, created_at, updated_at)
        VALUES ('lead-2', 'start-1', 'digest-2', 'thoughts-lead-2', '/repo', 'codex', 'gpt-5.6-sol', 'high', 'queued', 1, 1)
      `).run()).toThrow();
    } finally {
      sqlite.close();
    }
  });
});
