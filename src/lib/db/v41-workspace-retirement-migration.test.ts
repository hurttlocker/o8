import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV37WorkspaceSnapshotSchema } from './v37-workspace-snapshot-migration';
import { ensureV41WorkspaceRetirementSchema } from './v41-workspace-retirement-migration';

let sqlite: Database.Database | null = null;
const roots: string[] = [];

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(pathname: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('workspace retirement schema migration', () => {
  it('preserves snapshot receipts and admits retiring and retired states', () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    ensureV37WorkspaceSnapshotSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO workspace_snapshots (
        repository_uuid, packet_id, original_path, branch, base_commit, head_commit,
        tree_sha, recovery_ref, diff_fingerprint, snapshot_fingerprint, state,
        record_version, last_transition_id, transition_started_at, state_entered_at,
        created_at, updated_at
      ) VALUES ('repo', 'packet', '/tmp/packet', 'lane', 'base', 'head', 'tree',
        'refs/o8/recovery/packet', 'diff', 'fingerprint', 'materialized', 1,
        'created', 1, 1, 1, 1)
    `).run();
    sqlite.prepare(`
      INSERT INTO workspace_snapshot_transitions (
        repository_uuid, packet_id, transition_id, transition_kind, from_state,
        to_state, prior_version, resulting_version, transition_started_at,
        recorded_at, snapshot_fingerprint
      ) VALUES ('repo', 'packet', 'created', 'created', NULL, 'materialized', 0, 1, 1, 1, 'fingerprint')
    `).run();

    ensureV41WorkspaceRetirementSchema(sqlite);
    sqlite.prepare("UPDATE workspace_snapshots SET state = 'retiring'").run();
    sqlite.prepare("UPDATE workspace_snapshots SET state = 'retired'").run();

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM workspace_snapshot_transitions').get())
      .toEqual({ count: 1 });
    expect(() => sqlite!.prepare('DELETE FROM workspace_snapshot_transitions').run())
      .toThrow('append-only');
    expect(Number(sqlite.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(() => ensureV41WorkspaceRetirementSchema(sqlite!)).not.toThrow();
  });

  it('serializes two real processes upgrading the same v40 database', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-v41-concurrent-'));
    roots.push(root);
    const dbPath = path.join(root, 'cortex-ide.db');
    const lockMarker = path.join(root, 'holder-locked');
    const attemptMarker = path.join(root, 'contender-attempting');
    const releaseMarker = path.join(root, 'release-holder');
    sqlite = new Database(dbPath);
    sqlite.pragma('foreign_keys = ON');
    ensureV37WorkspaceSnapshotSchema(sqlite);
    sqlite.close();
    sqlite = null;
    const childPath = path.join(process.cwd(), 'tests/fixtures/workspace-retirement-migration-child.test.ts');
    const env = {
      ...process.env,
      O8_MIGRATION_DB_PATH: dbPath,
      O8_MIGRATION_LOCK_MARKER: lockMarker,
      O8_MIGRATION_ATTEMPT_MARKER: attemptMarker,
      O8_MIGRATION_RELEASE_MARKER: releaseMarker,
    };
    const holder = spawn(process.execPath, ['--import', 'tsx', childPath], {
      cwd: process.cwd(),
      env: { ...env, O8_MIGRATION_ROLE: 'holder' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitFor(lockMarker);
    const contender = spawn(process.execPath, ['--import', 'tsx', childPath], {
      cwd: process.cwd(),
      env: { ...env, O8_MIGRATION_ROLE: 'contender' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitFor(attemptMarker);
    writeFileSync(releaseMarker, 'release\n');
    const [[holderCode], [contenderCode]] = await Promise.all([
      once(holder, 'close') as Promise<[number | null]>,
      once(contender, 'close') as Promise<[number | null]>,
    ]);
    expect(holderCode).toBe(0);
    expect(contenderCode).toBe(0);

    sqlite = new Database(dbPath);
    expect(sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name = 'workspace_snapshots'`).get())
      .toMatchObject({ sql: expect.stringContaining("'retired'") });
    expect((sqlite.pragma('foreign_key_check') as unknown[]).length).toBe(0);
  }, 30_000);
});
