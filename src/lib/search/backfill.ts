import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getDb, getSqlite } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';
import { getRuntime } from '@/lib/runtimes';
import type { RuntimeId } from '@/lib/runtimes/types';
import { syncChatHistorySearchRecord, type SearchableChatHistoryRecord } from '@/lib/search/conversations';
import { syncTranscriptSearchDocument } from '@/lib/search/transcripts';

const CHAT_BACKFILL_NAME = 'v35-chat-history';
const TRANSCRIPT_BACKFILL_NAME = 'v35-packet-transcripts';
const CHAT_BATCH_SIZE = 12;
const TRANSCRIPT_BATCH_SIZE = 4;
const TRANSCRIPT_ENTRY_LIMIT = 5_000;
const MAX_TRANSCRIPTS_PER_BOOT = 64;
const MAX_TRANSCRIPT_PASSES = 3;

interface BackfillState {
  cursor: string;
  processed_count: number;
  pass_count: number;
  completed_at: string | null;
}

interface ChatBackfillRecord {
  file: string;
  modifiedAt: string;
  record: SearchableChatHistoryRecord;
}

interface TranscriptCandidate {
  cursor_id: string;
  cursor_at: string;
  packet_id: string;
  lane_id: string | null;
  session_key: string;
  title: string;
  repo_path: string;
  runtime: string;
  completed_at: string;
}

let started = false;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stateFor(name: string): BackfillState {
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT OR IGNORE INTO search_backfill_state(name) VALUES (?)
  `).run(name);
  return sqlite.prepare(`
    SELECT cursor, processed_count, pass_count, completed_at
    FROM search_backfill_state
    WHERE name = ?
  `).get(name) as BackfillState;
}

function updateState(
  name: string,
  input: { cursor: string; processedDelta?: number; passCount?: number; completed?: boolean },
): void {
  getSqlite().prepare(`
    UPDATE search_backfill_state
    SET cursor = ?,
        processed_count = processed_count + ?,
        pass_count = COALESCE(?, pass_count),
        completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
        updated_at = datetime('now')
    WHERE name = ?
  `).run(
    input.cursor,
    input.processedDelta ?? 0,
    input.passCount ?? null,
    input.completed === true ? 1 : 0,
    name,
  );
}

async function readChatBatch(files: string[]): Promise<ChatBackfillRecord[]> {
  const historyDir = join(getDataDir(), 'chat-history');
  const parsed = await Promise.all(files.map(async (file): Promise<ChatBackfillRecord | null> => {
    try {
      const filePath = join(historyDir, file);
      const [raw, fileStat] = await Promise.all([readFile(filePath, 'utf-8'), stat(filePath)]);
      const record = JSON.parse(raw) as SearchableChatHistoryRecord;
      if (!Array.isArray(record.messages)) return null;
      return { file, modifiedAt: fileStat.mtime.toISOString(), record };
    } catch (error) {
      console.warn('[search] chat backfill skipped malformed file', { file, error: String(error) });
      return null;
    }
  }));
  return parsed.filter((record): record is ChatBackfillRecord => record !== null);
}

export async function runChatHistorySearchBackfill(options?: { maxBatches?: number }): Promise<void> {
  if (!getDb()) return;
  const initial = stateFor(CHAT_BACKFILL_NAME);
  if (initial.completed_at) return;
  const historyDir = join(getDataDir(), 'chat-history');
  let files: string[];
  try {
    files = (await readdir(historyDir)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    updateState(CHAT_BACKFILL_NAME, { cursor: '', completed: true });
    return;
  }

  let cursor = initial.cursor;
  let batches = 0;
  const pending = files.filter((file) => file > cursor);
  console.info('[search] chat backfill started', { pending: pending.length, cursor: cursor || null });
  for (let offset = 0; offset < pending.length; offset += CHAT_BATCH_SIZE) {
    if (batches >= (options?.maxBatches ?? Number.POSITIVE_INFINITY)) {
      console.info('[search] chat backfill paused', { cursor });
      return;
    }
    const fileBatch = pending.slice(offset, offset + CHAT_BATCH_SIZE);
    const records = await readChatBatch(fileBatch);
    const apply = getSqlite().transaction(() => {
      for (const record of records) {
        syncChatHistorySearchRecord(basename(record.file, '.json'), record.record, record.modifiedAt);
      }
      cursor = fileBatch[fileBatch.length - 1] ?? cursor;
      updateState(CHAT_BACKFILL_NAME, { cursor, processedDelta: records.length });
    });
    apply();
    batches += 1;
    console.info('[search] chat backfill batch', { processed: records.length, cursor });
    await yieldToEventLoop();
  }
  updateState(CHAT_BACKFILL_NAME, { cursor, completed: true });
  console.info('[search] chat backfill complete', { processed: stateFor(CHAT_BACKFILL_NAME).processed_count });
}

function transcriptCursor(value: string): { at: string; id: string } {
  try {
    const parsed = JSON.parse(value) as { at?: unknown; id?: unknown };
    return {
      at: typeof parsed.at === 'string' ? parsed.at : '',
      id: typeof parsed.id === 'string' ? parsed.id : '',
    };
  } catch {
    return { at: '', id: '' };
  }
}

function transcriptCandidates(cursor: { at: string; id: string }): TranscriptCandidate[] {
  return getSqlite().prepare(`
    SELECT so.id AS cursor_id, so.completed_at AS cursor_at, so.packet_id,
      so.lane_id, so.session_key,
      COALESCE(l.label, 'Packet ' || so.packet_id) AS title,
      so.repo_path, COALESCE(l.runtime, so.runtime) AS runtime, so.completed_at
    FROM session_outcomes so
    LEFT JOIN lanes l ON l.id = so.lane_id
    WHERE so.packet_id IS NOT NULL
      AND so.session_key IS NOT NULL
      AND (so.completed_at > ? OR (so.completed_at = ? AND so.id > ?))
      AND NOT EXISTS (
        SELECT 1 FROM transcript_search_documents doc
        WHERE doc.packet_id = so.packet_id
      )
    ORDER BY so.completed_at, so.id
    LIMIT ?
  `).all(cursor.at, cursor.at, cursor.id, TRANSCRIPT_BATCH_SIZE) as TranscriptCandidate[];
}

function missingTranscriptCount(): number {
  const row = getSqlite().prepare(`
    SELECT COUNT(DISTINCT so.packet_id) AS count
    FROM session_outcomes so
    WHERE so.packet_id IS NOT NULL
      AND so.session_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transcript_search_documents doc
        WHERE doc.packet_id = so.packet_id
      )
  `).get() as { count: number };
  return row.count;
}

export async function runPacketTranscriptSearchBackfill(options?: {
  maxItems?: number;
  resolveRuntime?: typeof getRuntime;
}): Promise<void> {
  if (!getDb()) return;
  let state = stateFor(TRANSCRIPT_BACKFILL_NAME);
  if (state.completed_at) return;
  let cursor = transcriptCursor(state.cursor);
  let attempted = 0;
  let indexed = 0;
  console.info('[search] transcript backfill started', { cursor: cursor.at || null });

  const itemLimit = options?.maxItems ?? MAX_TRANSCRIPTS_PER_BOOT;
  const resolveRuntime = options?.resolveRuntime ?? getRuntime;
  while (attempted < itemLimit) {
    const candidates = transcriptCandidates(cursor).slice(0, itemLimit - attempted);
    if (candidates.length === 0) {
      const missing = missingTranscriptCount();
      if (missing === 0 || state.pass_count + 1 >= MAX_TRANSCRIPT_PASSES) {
        updateState(TRANSCRIPT_BACKFILL_NAME, {
          cursor: state.cursor,
          passCount: state.pass_count,
          completed: true,
        });
        console.info('[search] transcript backfill complete', { indexed, missing });
        return;
      }
      state = { ...state, cursor: '', pass_count: state.pass_count + 1 };
      cursor = { at: '', id: '' };
      updateState(TRANSCRIPT_BACKFILL_NAME, { cursor: '', passCount: state.pass_count });
      console.info('[search] transcript backfill retry pass', { pass: state.pass_count + 1, missing });
      await yieldToEventLoop();
      continue;
    }

    for (const candidate of candidates) {
      attempted += 1;
      const runtime = resolveRuntime(candidate.runtime as RuntimeId);
      try {
        if (!runtime?.capabilities.readTranscript) throw new Error(`runtime unavailable: ${candidate.runtime}`);
        const entries = await runtime.readTranscript(
          candidate.session_key,
          undefined,
          TRANSCRIPT_ENTRY_LIMIT,
        );
        syncTranscriptSearchDocument({
          packetId: candidate.packet_id,
          laneId: candidate.lane_id,
          sessionKey: candidate.session_key,
          title: candidate.title,
          repoPath: candidate.repo_path,
          runtime: candidate.runtime,
          entries,
          completedAt: candidate.completed_at,
        });
        indexed += entries.length > 0 ? 1 : 0;
      } catch (error) {
        console.warn('[search] transcript backfill item failed', {
          packetId: candidate.packet_id,
          runtime: candidate.runtime,
          error: String(error),
        });
      }
      cursor = { at: candidate.cursor_at, id: candidate.cursor_id };
    }
    state.cursor = JSON.stringify(cursor);
    updateState(TRANSCRIPT_BACKFILL_NAME, {
      cursor: state.cursor,
      processedDelta: candidates.length,
      passCount: state.pass_count,
    });
    console.info('[search] transcript backfill batch', { attempted, indexed, cursor: cursor.at });
    await yieldToEventLoop();
  }
  console.info('[search] transcript backfill paused', { attempted, indexed, cursor: cursor.at });
}

export async function runUnifiedSearchBackfills(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await runChatHistorySearchBackfill();
    await runPacketTranscriptSearchBackfill();
  } catch (error) {
    console.warn('[search] deferred backfill failed', { error: String(error) });
  } finally {
    started = false;
  }
}
