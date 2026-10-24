import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getSqlite } from '@/lib/db';

const runtime = vi.hoisted(() => ({ loaded: vi.fn(), readTranscript: vi.fn() }));
vi.mock('@/lib/runtimes', () => {
  runtime.loaded();
  return { getRuntime: () => ({ capabilities: { readTranscript: true }, readTranscript: runtime.readTranscript }) };
});

beforeEach(() => {
  getDb();
  getSqlite().prepare('DELETE FROM session_outcomes').run();
  getSqlite().prepare('DELETE FROM transcript_search_documents').run();
  getSqlite().prepare('DELETE FROM search_backfill_state').run();
});

describe('startup search backfill module ownership', () => {
  it('does not load worker adapters when there are no persisted transcripts to recover', async () => {
    const { runPacketTranscriptSearchBackfill } = await import('@/lib/search/backfill');
    await runPacketTranscriptSearchBackfill();
    expect(runtime.loaded).not.toHaveBeenCalled();
  });

  it('loads adapters on demand and persists a pending transcript through the normal backfill', async () => {
    getSqlite().prepare(`
      INSERT INTO session_outcomes (
        id, repo_path, runtime, session_key, packet_id, outcome, summary,
        retry_history_json, patterns_json, conflict_zones_json, changed_files_json,
        started_at, completed_at, valid_from
      ) VALUES ('memory-fixture', '/tmp/o8-memory-fixture', 'codex', 'fixture-session',
        'fixture-packet', 'succeeded', 'Fixture', '[]', '[]', '[]', '[]',
        '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z')
    `).run();
    runtime.readTranscript.mockResolvedValue([{ id: 'entry', role: 'assistant', text: 'Recovered fixture transcript', timestamp: new Date(0) }]);
    const { runPacketTranscriptSearchBackfill } = await import('@/lib/search/backfill');
    await runPacketTranscriptSearchBackfill();
    expect(runtime.loaded).toHaveBeenCalledTimes(1);
    expect(runtime.readTranscript).toHaveBeenCalledWith('fixture-session', undefined, 5000);
    expect(getSqlite().prepare('SELECT transcript_text FROM transcript_search_documents WHERE packet_id = ?').get('fixture-packet'))
      .toEqual({ transcript_text: 'assistant: Recovered fixture transcript' });
  });
});
