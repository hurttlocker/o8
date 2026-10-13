import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, onTestFailed } from 'vitest';

import {
  queryCodexProcessBindings,
  queryCodexThreadByIdFromHome,
  queryCodexThreadsFromHome,
} from '@/lib/codex/discovery-store';

// The serial integration gate owns this fresh fixture namespace and teardown.
const root = mkdtempSync(path.join(os.tmpdir(), 'o8-discovery-readonly-'));
const threadId = "discovery-'quoted-thread";

function fixture(label: string, logs = true) {
  const home = path.join(root, label);
  mkdirSync(home, { mode: 0o700 });
  const dbPath = path.join(home, 'state_5.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
      rollout_path TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT,
      first_user_message TEXT, model TEXT, archived INTEGER
    );
  `);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'Original title', home, 1, path.join(home, 'rollout.jsonl'),
    'main', 'fixture-commit', '', 'Useful fixture', 'fixture-model', 0,
  );
  if (logs) {
    db.exec('CREATE TABLE logs (thread_id TEXT, process_uuid TEXT, ts INTEGER);');
    db.prepare('INSERT INTO logs VALUES (?, ?, ?)').run(threadId, 'fixture-process', 1);
  }
  return { home, dbPath, db };
}

function preservedFile(file: string) {
  const stat = statSync(file);
  return {
    device: stat.dev, inode: stat.ino, size: stat.size,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  };
}

beforeEach(({ task }) => {
  onTestFailed(() => {
    const parent = process.env.O8_TEST_RUN_DATA_ROOT;
    if (!parent || path.resolve(parent) !== path.dirname(root)) {
      throw new Error('Failed fixture retention requires its owned integration parent.');
    }
    const retain = path.join(parent, '.o8-test-run-retain.json');
    if (!existsSync(retain)) writeFileSync(retain, JSON.stringify({
      reason: 'discovery_readonly_regression_failure', test: task.name,
    }) + '\n', { flag: 'wx', mode: 0o600 });
  });
});

describe('real SQLite discovery connections', () => {
  it('does not create a missing database', async () => {
    const home = path.join(root, 'absent');
    mkdirSync(home);
    expect(await queryCodexThreadsFromHome(home)).toEqual([]);
    expect(await queryCodexThreadByIdFromHome(home, threadId)).toBeNull();
    expect(await queryCodexProcessBindings(home)).toEqual([]);
    expect(existsSync(path.join(home, 'state_5.sqlite'))).toBe(false);
  });

  it('reads thread listing, quoted lookup and process bindings without changing state', async () => {
    const f = fixture('ordinary');
    f.db.close();
    const before = preservedFile(f.dbPath);
    expect(await queryCodexThreadsFromHome(f.home)).toMatchObject([{ id: threadId, title: 'Original title' }]);
    expect(await queryCodexThreadByIdFromHome(f.home, threadId)).toMatchObject({ id: threadId });
    expect(await queryCodexThreadByIdFromHome(f.home, 'missing')).toBeNull();
    expect(await queryCodexProcessBindings(f.home)).toEqual([
      { thread_id: threadId, process_uuid: 'fixture-process', last_ts: 1 },
    ]);
    expect(preservedFile(f.dbPath)).toEqual(before);
    expect(existsSync(f.dbPath + '-journal')).toBe(false);
  });

  it('retains the supported missing-logs-schema result', async () => {
    const f = fixture('without-logs', false);
    f.db.close();
    const before = preservedFile(f.dbPath);
    expect(await queryCodexProcessBindings(f.home)).toEqual([]);
    expect(preservedFile(f.dbPath)).toEqual(before);
  });

  it('sees current committed WAL rows while the writer stays open without changing database or WAL', async () => {
    const f = fixture('concurrent-wal');
    try {
      expect(f.db.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
      f.db.pragma('wal_autocheckpoint = 0');
      for (let version = 2; version <= 3; version += 1) {
        f.db.transaction(() => {
          f.db.prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
            .run('Committed ' + version, version, threadId);
          f.db.prepare('INSERT INTO logs VALUES (?, ?, ?)').run(threadId, 'fixture-process', version);
        })();
        const before = { db: preservedFile(f.dbPath), wal: preservedFile(f.dbPath + '-wal') };
        expect(await queryCodexThreadsFromHome(f.home)).toMatchObject([{ title: 'Committed ' + version }]);
        expect(await queryCodexThreadByIdFromHome(f.home, threadId)).toMatchObject({ updated_at: version });
        expect(await queryCodexProcessBindings(f.home)).toMatchObject([{ last_ts: version }]);
        expect({ db: preservedFile(f.dbPath), wal: preservedFile(f.dbPath + '-wal') }).toEqual(before);
        expect(f.db.prepare('SELECT title FROM threads WHERE id = ?').get(threadId))
          .toEqual({ title: 'Committed ' + version });
      }
    } finally {
      f.db.close();
    }
  });

  it.each(['listing', 'lookup', 'bindings'] as const)(
    'refuses %s when a hot journal requires recovery and preserves its original bytes', async (kind) => {
      const f = fixture('hot-' + kind);
      const insert = f.db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      f.db.transaction(() => {
        for (let index = 0; index < 128; index += 1) insert.run(
          'spill-' + index, 'a'.repeat(10_000), f.home, 1,
          path.join(f.home, 'spill.jsonl'), '', '', '', '', '', 0,
        );
      })();
      f.db.close();
      // The owned fixture child exits itself after spilling an uncommitted
      // transaction. No process signal or shared provider state is involved.
      execFileSync('python3', ['-I', '-B', '-c', [
        'import os, sqlite3, sys',
        'db = sqlite3.connect(sys.argv[1])',
        "db.execute('PRAGMA cache_size = 2')",
        "db.execute('BEGIN IMMEDIATE')",
        "db.execute(\"UPDATE threads SET title = ?\", ('b' * 10000,))",
        'os._exit(0)',
      ].join('\n'), f.dbPath], { timeout: 10_000, stdio: 'pipe' });
      const journal = f.dbPath + '-journal';
      expect(readFileSync(journal).subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7');
      const before = { db: preservedFile(f.dbPath), journal: preservedFile(journal) };
      const query = kind === 'listing' ? queryCodexThreadsFromHome(f.home)
        : kind === 'lookup' ? queryCodexThreadByIdFromHome(f.home, threadId)
          : queryCodexProcessBindings(f.home);
      await expect(query).rejects.toThrow(/readonly|read-only/i);
      expect({ db: preservedFile(f.dbPath), journal: preservedFile(journal) }).toEqual(before);
    },
  );
});
