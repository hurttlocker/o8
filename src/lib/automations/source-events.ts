import { createHash } from 'node:crypto';

import { redactBroadcastRecord } from '@/lib/broadcast/redaction';
import { getSqlite } from '@/lib/db';

const MAX_PAYLOAD_BYTES = 8 * 1024;

export type AutomationSourceKind = 'managed_run' | 'packet' | 'repository';

export interface AutomationSourceEvent {
  sequence: number;
  sourceKind: AutomationSourceKind;
  sourceId: string;
  repoPath: string | null;
  eventType: string;
  fingerprint: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  persistedAt: number;
}

interface SourceEventRow {
  sequence: number;
  source_kind: AutomationSourceKind;
  source_id: string;
  repo_path: string | null;
  event_type: string;
  fingerprint: string;
  payload_json: string;
  occurred_at: number;
  persisted_at: number;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sourceEventFromRow(row: SourceEventRow): AutomationSourceEvent {
  return {
    sequence: row.sequence,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    repoPath: row.repo_path,
    eventType: row.event_type,
    fingerprint: row.fingerprint,
    payload: parsePayload(row.payload_json),
    occurredAt: row.occurred_at,
    persistedAt: row.persisted_at,
  };
}

function boundedPayload(payload: Record<string, unknown>): string {
  const redacted = redactBroadcastRecord(payload);
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized;
  const preview = Buffer.from(serialized, 'utf8')
    .subarray(0, MAX_PAYLOAD_BYTES - 256)
    .toString('utf8')
    .replace(/\uFFFD+$/, '');
  return JSON.stringify({
    truncated: true,
    byteLimit: MAX_PAYLOAD_BYTES,
    preview,
  });
}

export function boundAutomationSourcePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return parsePayload(boundedPayload(payload));
}

function derivedFingerprint(input: {
  sourceKind: AutomationSourceKind;
  sourceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function recordAutomationSourceEvent(input: {
  sourceKind: AutomationSourceKind;
  sourceId: string;
  repoPath?: string | null;
  eventType: string;
  fingerprint?: string;
  payload?: Record<string, unknown>;
  occurredAt?: number;
  persistedAt?: number;
}): AutomationSourceEvent {
  const sqlite = getSqlite();
  const occurredAt = input.occurredAt ?? Date.now();
  const persistedAt = input.persistedAt ?? Date.now();
  const payload = input.payload ?? {};
  const fingerprint = input.fingerprint ?? derivedFingerprint({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    eventType: input.eventType,
    payload,
    occurredAt,
  });
  const persist = sqlite.transaction(() => {
    if (input.eventType === 'output') {
      const latest = sqlite.prepare(`
        SELECT * FROM automation_source_events
        WHERE source_kind = ? AND source_id = ?
        ORDER BY sequence DESC LIMIT 1
      `).get(input.sourceKind, input.sourceId) as SourceEventRow | undefined;
      if (latest && (latest.event_type === 'quiet' || latest.event_type === 'lost')) {
        sqlite.prepare(`
          INSERT OR IGNORE INTO automation_source_events (
            source_kind, source_id, repo_path, event_type, fingerprint,
            payload_json, occurred_at, persisted_at
          ) VALUES (?, ?, ?, 'recovered', ?, ?, ?, ?)
        `).run(
          input.sourceKind,
          input.sourceId,
          input.repoPath ?? latest.repo_path,
          `${fingerprint}:recovered`,
          boundedPayload({
            provenance: { sourceKind: input.sourceKind, sourceId: input.sourceId },
            recoveredFrom: latest.event_type,
          }),
          occurredAt,
          persistedAt,
        );
      }
    }
    sqlite.prepare(`
      INSERT OR IGNORE INTO automation_source_events (
        source_kind, source_id, repo_path, event_type, fingerprint,
        payload_json, occurred_at, persisted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceKind,
      input.sourceId,
      input.repoPath ?? null,
      input.eventType,
      fingerprint,
      boundedPayload({
        provenance: {
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          eventType: input.eventType,
        },
        ...payload,
      }),
      occurredAt,
      persistedAt,
    );
    return sqlite.prepare('SELECT * FROM automation_source_events WHERE fingerprint = ?')
      .get(fingerprint) as SourceEventRow;
  });
  return sourceEventFromRow(persist.immediate());
}

export function listAutomationSourceEvents(input: {
  sourceKind: AutomationSourceKind;
  afterSequence: number;
  repoPath?: string | null;
  sourceId?: string | null;
  limit?: number;
}): AutomationSourceEvent[] {
  const clauses = ['source_kind = ?', 'sequence > ?'];
  const values: Array<string | number> = [input.sourceKind, input.afterSequence];
  if (input.repoPath) {
    clauses.push('repo_path = ?');
    values.push(input.repoPath);
  }
  if (input.sourceId) {
    clauses.push('source_id = ?');
    values.push(input.sourceId);
  }
  const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
  const rows = getSqlite().prepare(`
    SELECT * FROM automation_source_events
    WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC LIMIT ?
  `).all(...values, limit) as SourceEventRow[];
  return rows.map(sourceEventFromRow);
}

export function latestAutomationSourceSequence(input: {
  sourceKind: AutomationSourceKind;
  repoPath?: string | null;
  sourceId?: string | null;
}): number {
  const clauses = ['source_kind = ?'];
  const values: string[] = [input.sourceKind];
  if (input.repoPath) {
    clauses.push('repo_path = ?');
    values.push(input.repoPath);
  }
  if (input.sourceId) {
    clauses.push('source_id = ?');
    values.push(input.sourceId);
  }
  const row = getSqlite().prepare(`
    SELECT MAX(sequence) AS sequence FROM automation_source_events
    WHERE ${clauses.join(' AND ')}
  `).get(...values) as { sequence: number | null };
  return row.sequence ?? 0;
}

export function ingestLaneAutomationSourceEvents(limit: number = 500, nowMs: number = Date.now()): number {
  const sqlite = getSqlite();
  const ingest = sqlite.transaction(() => {
    const checkpointRow = sqlite.prepare(`
      SELECT checkpoint FROM automation_source_ingest_state WHERE source_kind = 'lane'
    `).get() as { checkpoint: number } | undefined;
    const checkpoint = checkpointRow?.checkpoint ?? 0;
    const rows = sqlite.prepare(`
      SELECT event.rowid AS source_sequence, event.id, event.lane_id, event.verb,
             event.actor, event.payload_json, event.timestamp,
             lane.packet_id, lane.repo_path
      FROM lane_events event
      JOIN lanes lane ON lane.id = event.lane_id
      WHERE event.rowid > ? ORDER BY event.rowid ASC LIMIT ?
    `).all(checkpoint, Math.min(2_000, Math.max(1, Math.floor(limit)))) as Array<{
      source_sequence: number;
      id: string;
      lane_id: string;
      verb: string;
      actor: string;
      payload_json: string;
      timestamp: string;
      packet_id: string | null;
      repo_path: string;
    }>;
    for (const row of rows) {
      const payload = parsePayload(row.payload_json);
      const eventLabel = typeof payload.eventLabel === 'string' && payload.eventLabel.trim()
        ? payload.eventLabel.trim()
        : typeof payload.status === 'string' && payload.status.trim()
          ? payload.status.trim()
          : row.verb;
      recordAutomationSourceEvent({
        sourceKind: 'packet',
        sourceId: row.packet_id ?? row.lane_id,
        repoPath: row.repo_path,
        eventType: eventLabel,
        fingerprint: `lane:${row.id}`,
        occurredAt: Date.parse(row.timestamp) || nowMs,
        persistedAt: nowMs,
        payload: {
          laneEventId: row.id,
          laneId: row.lane_id,
          packetId: row.packet_id,
          actor: row.actor,
          verb: row.verb,
          data: payload,
        },
      });
    }
    const nextCheckpoint = rows.at(-1)?.source_sequence ?? checkpoint;
    sqlite.prepare(`
      INSERT INTO automation_source_ingest_state (source_kind, checkpoint, updated_at)
      VALUES ('lane', ?, ?)
      ON CONFLICT(source_kind) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = excluded.updated_at
    `).run(nextCheckpoint, nowMs);
    return rows.length;
  });
  return ingest.immediate();
}
