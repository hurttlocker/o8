import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-v65-legacy-schema-'));
const dbPath = join(dataDir, 'cortex-ide.db');
const token = 'v65-legacy-schema-operator-token';
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  WS_TOKEN: process.env.WS_TOKEN,
};

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.WS_TOKEN = token;

afterAll(async () => {
  await import('@/lib/db').then((db) => db.closeDb()).catch(() => undefined);
  vi.resetModules();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function operatorGet(url: string): NextRequest {
  return new NextRequest(url, {
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
    },
  });
}

async function seedLegacyV65Database(): Promise<void> {
  const initialDb = await import('@/lib/db');
  initialDb.getSqlite();
  initialDb.closeDb();

  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(`
      DROP TABLE orchestrator_lead_turns;
      CREATE TABLE orchestrator_lead_turns (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES orchestrator_leads(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        display_message TEXT NOT NULL DEFAULT '',
        permission_mode TEXT NOT NULL DEFAULT 'full',
        attachments_json TEXT,
        brief_json TEXT,
        status TEXT NOT NULL,
        result_text TEXT,
        error TEXT,
        session_id TEXT,
        owner_pid INTEGER,
        owner_identity_json TEXT,
        lease_token TEXT,
        lease_heartbeat_at INTEGER,
        outcome_kind TEXT,
        outcome_summary TEXT,
        outcome_evidence_json TEXT,
        outcome_reported_at INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        UNIQUE(lead_id, idempotency_key),
        UNIQUE(lead_id, ordinal)
      );
      INSERT INTO orchestrator_leads
        (id, start_key, request_digest, thread_id, repo_path, backend, model, effort, status, created_at, updated_at)
      VALUES ('legacy-lead', 'legacy-start', 'legacy-digest', 'legacy-thread', '/fixture', 'codex', 'fixture-model', 'low', 'completed', 1, 1);
      INSERT INTO orchestrator_lead_turns
        (id, lead_id, idempotency_key, ordinal, kind, message, status, created_at)
      VALUES ('legacy-turn', 'legacy-lead', 'legacy-turn-key', 1, 'start', 'preserve this turn', 'completed', 1);
    `);
  } finally {
    sqlite.close();
  }
}

describe('legacy v65 lead schema through product boot and route handlers', () => {
  it('adds root_turn_id before indexing, preserves turns, and keeps fleet and missing-lead reads healthy', async () => {
    await seedLegacyV65Database();

    vi.resetModules();
    const db = await import('@/lib/db');
    const sqlite = db.getSqlite();
    const columns = sqlite.prepare('PRAGMA table_info(orchestrator_lead_turns)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('root_turn_id');
    expect(sqlite.prepare(`SELECT id, message, root_turn_id FROM orchestrator_lead_turns WHERE id = 'legacy-turn'`).get())
      .toEqual({ id: 'legacy-turn', message: 'preserve this turn', root_turn_id: null });
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orchestrator_lead_turns_root'`).get())
      .toEqual({ name: 'idx_orchestrator_lead_turns_root' });

    const lanesRoute = await import('@/app/api/lanes/route');
    const lanesResponse = await lanesRoute.GET(operatorGet('http://localhost:3001/api/lanes?active=false'));
    expect(lanesResponse.status).toBe(200);

    const leadRoute = await import('@/app/api/orchestrator/lead/route');
    const missingLeadResponse = await leadRoute.GET(operatorGet(
      'http://localhost:3001/api/orchestrator/lead?leadId=missing-legacy-lead',
    ));
    expect(missingLeadResponse.status).toBe(404);
    expect(await missingLeadResponse.json()).toMatchObject({
      error: { code: 'lead_not_found' },
    });

    db.closeDb();
  });
});
