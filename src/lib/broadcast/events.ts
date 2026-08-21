import 'server-only';

import path from 'node:path';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { redactBroadcastRecord, redactBroadcastText } from './redaction';
import {
  BROADCAST_EVENT_KINDS,
  type BroadcastEvent,
  type BroadcastEventKind,
  type BroadcastEventPage,
} from './types';

const BROADCAST_KIND_SET = new Set<string>(BROADCAST_EVENT_KINDS);
const RAW_BATCH_SIZE = 250;
const MAX_EVENT_LIMIT = 100;

interface RawBroadcastRow {
  id: string;
  source: BroadcastEvent['source'];
  raw_source: 'lane' | 'lease' | 'approval_create' | 'approval_event';
  ordinal: number;
  source_kind: string;
  actor: string;
  payload_json: string;
  timestamp: string;
  lane_id: string | null;
  packet_id: string | null;
  repo_path: string | null;
  lane_label: string | null;
  approval_title: string | null;
  approval_risk: string | null;
  resource: string | null;
}

interface BroadcastCursor {
  v: 1;
  positions: Record<RawBroadcastRow['raw_source'], number>;
}

interface RawScanCursor {
  timestamp: string;
  rawSource: RawBroadcastRow['raw_source'];
  ordinal: number;
}

export interface ListBroadcastEventsOptions {
  cursor?: string | null;
  limit?: number;
  repo?: string | null;
  lane?: string | null;
  kinds?: Iterable<string> | null;
}

export type ListRecentBroadcastEventsOptions = Omit<ListBroadcastEventsOptions, 'cursor'>;

export class BroadcastQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastQueryError';
  }
}

const EVENT_UNION_SQL = `
  SELECT
    event.id AS id,
    'lane' AS source,
    'lane' AS raw_source,
    event.rowid AS ordinal,
    event.verb AS source_kind,
    event.actor AS actor,
    event.payload_json AS payload_json,
    event.timestamp AS timestamp,
    event.lane_id AS lane_id,
    lane.packet_id AS packet_id,
    lane.repo_path AS repo_path,
    lane.label AS lane_label,
    NULL AS approval_title,
    NULL AS approval_risk,
    NULL AS resource
  FROM lane_events event
  JOIN lanes lane ON lane.id = event.lane_id

  UNION ALL

  SELECT
    event.id AS id,
    'lease' AS source,
    'lease' AS raw_source,
    event.sequence AS ordinal,
    event.verb AS source_kind,
    event.actor AS actor,
    event.payload_json AS payload_json,
    event.timestamp AS timestamp,
    NULL AS lane_id,
    NULL AS packet_id,
    CASE
      WHEN event.resource LIKE 'repo-tree:%' THEN substr(event.resource, 11)
      ELSE NULL
    END AS repo_path,
    NULL AS lane_label,
    NULL AS approval_title,
    NULL AS approval_risk,
    event.resource AS resource
  FROM resource_lease_events event

  UNION ALL

  SELECT
    'created:' || approval.id AS id,
    'approval' AS source,
    'approval_create' AS raw_source,
    approval.rowid AS ordinal,
    'created' AS source_kind,
    'system' AS actor,
    json_object('status', 'pending') AS payload_json,
    strftime('%Y-%m-%dT%H:%M:%fZ', approval.created_at / 1000.0, 'unixepoch') AS timestamp,
    approval.lane_id AS lane_id,
    approval.packet_id AS packet_id,
    lane.repo_path AS repo_path,
    lane.label AS lane_label,
    approval.title AS approval_title,
    approval.risk AS approval_risk,
    NULL AS resource
  FROM approvals approval
  LEFT JOIN lanes lane ON lane.id = approval.lane_id

  UNION ALL

  SELECT
    event.id AS id,
    'approval' AS source,
    'approval_event' AS raw_source,
    event.rowid AS ordinal,
    event.event_type AS source_kind,
    event.actor AS actor,
    json_patch(event.details_json, json_object('note', event.note)) AS payload_json,
    strftime('%Y-%m-%dT%H:%M:%fZ', event.timestamp / 1000.0, 'unixepoch') AS timestamp,
    approval.lane_id AS lane_id,
    approval.packet_id AS packet_id,
    lane.repo_path AS repo_path,
    lane.label AS lane_label,
    approval.title AS approval_title,
    approval.risk AS approval_risk,
    NULL AS resource
  FROM approval_events event
  JOIN approvals approval ON approval.id = event.approval_id
  LEFT JOIN lanes lane ON lane.id = approval.lane_id
`;

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit)) return 50;
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, Number(limit)));
}

function encodeCursor(cursor: BroadcastCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeBroadcastCursor(value: string): BroadcastCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<BroadcastCursor>;
    if (
      parsed.v !== 1
      || !parsed.positions
      || !['lane', 'lease', 'approval_create', 'approval_event'].every((source) => {
        const position = parsed.positions?.[source as keyof typeof parsed.positions];
        return Number.isSafeInteger(position) && Number(position) >= 0;
      })
    ) return null;
    return parsed as BroadcastCursor;
  } catch {
    return null;
  }
}

function rawRowsAfter(
  sqlite: Database.Database,
  cursor: BroadcastCursor,
  limit: number,
): RawBroadcastRow[] {
  return sqlite.prepare(`
    SELECT * FROM (${EVENT_UNION_SQL})
    WHERE (raw_source = 'lane' AND ordinal > ?)
      OR (raw_source = 'lease' AND ordinal > ?)
      OR (raw_source = 'approval_create' AND ordinal > ?)
      OR (raw_source = 'approval_event' AND ordinal > ?)
    ORDER BY timestamp ASC, raw_source ASC, ordinal ASC
    LIMIT ?
  `).all(
    cursor.positions.lane,
    cursor.positions.lease,
    cursor.positions.approval_create,
    cursor.positions.approval_event,
    limit,
  ) as RawBroadcastRow[];
}

function rawRowsBefore(
  sqlite: Database.Database,
  cursor: RawScanCursor | null,
  limit: number,
): RawBroadcastRow[] {
  if (!cursor) {
    return sqlite.prepare(`
      SELECT * FROM (${EVENT_UNION_SQL})
      ORDER BY timestamp DESC, raw_source DESC, ordinal DESC
      LIMIT ?
    `).all(limit) as RawBroadcastRow[];
  }
  return sqlite.prepare(`
    SELECT * FROM (${EVENT_UNION_SQL})
    WHERE timestamp < ?
      OR (timestamp = ? AND raw_source < ?)
      OR (timestamp = ? AND raw_source = ? AND ordinal < ?)
    ORDER BY timestamp DESC, raw_source DESC, ordinal DESC
    LIMIT ?
  `).all(
    cursor.timestamp,
    cursor.timestamp, cursor.rawSource,
    cursor.timestamp, cursor.rawSource, cursor.ordinal,
    limit,
  ) as RawBroadcastRow[];
}

function currentCursor(sqlite: Database.Database): BroadcastCursor {
  const row = sqlite.prepare(`
    SELECT
      COALESCE((SELECT MAX(rowid) FROM lane_events), 0) AS lane,
      COALESCE((SELECT MAX(sequence) FROM resource_lease_events), 0) AS lease,
      COALESCE((SELECT MAX(rowid) FROM approvals), 0) AS approval_create,
      COALESCE((SELECT MAX(rowid) FROM approval_events), 0) AS approval_event
  `).get() as BroadcastCursor['positions'];
  return { v: 1, positions: row };
}

function emptyCursor(): BroadcastCursor {
  return {
    v: 1,
    positions: {
      lane: 0,
      lease: 0,
      approval_create: 0,
      approval_event: 0,
    },
  };
}

function advanceCursor(cursor: BroadcastCursor, row: RawBroadcastRow): BroadcastCursor {
  return {
    v: 1,
    positions: {
      ...cursor.positions,
      [row.raw_source]: Math.max(cursor.positions[row.raw_source], row.ordinal),
    },
  };
}

function eventKind(row: RawBroadcastRow, payload: Record<string, unknown>): BroadcastEventKind | null {
  if (row.source === 'lease') {
    if (row.source_kind === 'acquired') return 'lease_acquired';
    if (row.source_kind === 'released' || row.source_kind === 'reaped') return 'lease_released';
    return null;
  }
  if (row.source === 'approval') {
    if (row.source_kind === 'orchestrator_review') return 'review_verdict';
    if (row.source_kind === 'created' || row.source_kind === 'approved' || row.source_kind === 'rejected') {
      return 'approval';
    }
    return null;
  }
  if (row.source_kind === 'brain_consulted') return 'brain_consulted';
  if (row.source_kind === 'lease_wait_timeout') return 'lease_timeout';
  if (row.source_kind === 'review_recorded') return 'review_verdict';
  if (row.source_kind === 'merge' || row.source_kind === 'pr_merged_reconciled' || row.source_kind === 'merged_by_ancestry_reconciled') return 'merge';
  if (row.source_kind === 'message') return 'message';
  if (row.source_kind === 'agent_report') {
    return 'progress';
  }
  if (row.source_kind === 'status_change') {
    const label = typeof payload.eventLabel === 'string' ? payload.eventLabel : '';
    if (label === 'session_launched' || label === 'session_launch_recovered') return 'session_launched';
    if (label === 'agent_completed' || label === 'completed') return 'agent_completed';
    if (label === 'merged' || label === 'merged_pushed') return 'merge';
  }
  return null;
}

function repoLabel(repoPath: string | null): string | null {
  if (!repoPath) return null;
  const normalized = repoPath.replace(/[\\/]+$/, '');
  return path.basename(normalized) || null;
}

function detailFor(kind: BroadcastEventKind, row: RawBroadcastRow, payload: Record<string, unknown>): string | null {
  if (kind === 'progress') return typeof payload.message === 'string' ? payload.message : null;
  if (kind === 'brain_consulted') return typeof payload.question === 'string' ? payload.question : null;
  if (kind === 'lease_timeout') return typeof payload.resource === 'string' ? payload.resource : null;
  if (kind === 'review_verdict') {
    if (typeof payload.summary === 'string') return payload.summary;
    if (typeof payload.note === 'string') return payload.note;
    if (typeof payload.approved === 'boolean') return payload.approved ? 'Approved' : 'Changes requested';
  }
  if (kind === 'approval') return row.approval_title;
  if (kind === 'message') return typeof payload.message === 'string' ? payload.message : null;
  if (kind.startsWith('lease_')) return row.resource;
  return null;
}

function titleFor(
  kind: BroadcastEventKind,
  row: RawBroadcastRow,
  payload: Record<string, unknown>,
): string {
  const subject = row.lane_label || row.approval_title || row.resource;
  const reportLabel = typeof payload.event === 'string' && payload.event.trim()
    ? `Agent ${payload.event.trim().replaceAll('_', ' ')}`
    : 'Agent report';
  const labels: Record<BroadcastEventKind, string> = {
    session_launched: 'Session launched',
    progress: reportLabel,
    brain_consulted: 'Brain consulted',
    lease_acquired: 'Lease acquired',
    lease_released: 'Lease released',
    lease_timeout: 'Lease wait timed out',
    review_verdict: 'Review verdict',
    merge: 'Change merged',
    approval: 'Approval activity',
    agent_completed: 'Agent completed',
    message: 'Agent message',
  };
  return subject ? `${labels[kind]} · ${subject}` : labels[kind];
}

function repoMatches(row: RawBroadcastRow, requested: string | null | undefined): boolean {
  const filter = requested?.trim();
  if (!filter) return true;
  const raw = row.repo_path?.replace(/[\\/]+$/, '') ?? '';
  return raw === filter || repoLabel(raw) === filter;
}

function laneMatches(row: RawBroadcastRow, requested: string | null | undefined): boolean {
  const filter = requested?.trim();
  return !filter || row.lane_id === filter;
}

function mapEvent(
  row: RawBroadcastRow,
  requestedKinds: Set<string> | null,
  repo: string | null | undefined,
  lane: string | null | undefined,
): BroadcastEvent | null {
  if (!repoMatches(row, repo) || !laneMatches(row, lane)) return null;
  const payload = parsePayload(row.payload_json);
  const kind = eventKind(row, payload);
  if (!kind || (requestedKinds && !requestedKinds.has(kind))) return null;
  const redactedPayload = redactBroadcastRecord(payload);
  const detail = detailFor(kind, row, redactedPayload);
  return {
    schema: 'o8/broadcast.event/v1',
    id: `${row.source}:${row.id}`,
    source: row.source,
    kind,
    laneId: row.lane_id,
    packetId: row.packet_id,
    repo: repoLabel(row.repo_path),
    actor: redactBroadcastText(row.actor),
    title: redactBroadcastText(titleFor(kind, row, redactedPayload)),
    detail: detail ? redactBroadcastText(detail) : null,
    payload: redactedPayload,
    timestamp: row.timestamp,
  };
}

function requestedKinds(values: Iterable<string> | null | undefined): Set<string> | null {
  if (!values) return null;
  const kinds = new Set([...values].map((value) => value.trim()).filter(Boolean));
  if (kinds.size === 0) return null;
  for (const kind of kinds) {
    if (!BROADCAST_KIND_SET.has(kind)) throw new BroadcastQueryError(`Unknown Broadcast event kind: ${kind}`);
  }
  return kinds;
}

export function listBroadcastEvents(
  options: ListBroadcastEventsOptions = {},
  sqlite: Database.Database = getSqlite(),
): BroadcastEventPage {
  const limit = normalizeLimit(options.limit);
  const kinds = requestedKinds(options.kinds);
  const encodedInput = options.cursor?.trim() || null;
  const decoded = encodedInput ? decodeBroadcastCursor(encodedInput) : null;
  if (encodedInput && !decoded) throw new BroadcastQueryError('Broadcast cursor is invalid.');

  const events: BroadcastEvent[] = [];
  let scanCursor: BroadcastCursor = decoded
    ? { v: 1, positions: { ...decoded.positions } }
    : emptyCursor();
  let hasMore = false;
  for (;;) {
    const rows = rawRowsAfter(sqlite, scanCursor, RAW_BATCH_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      scanCursor = advanceCursor(scanCursor, row);
      const event = mapEvent(row, kinds, options.repo, options.lane);
      if (event) events.push(event);
      if (events.length === limit) {
        hasMore = rawRowsAfter(sqlite, scanCursor, 1).length > 0;
        return {
          schema: 'o8/broadcast.events/v1',
          events,
          cursor: encodeCursor(scanCursor),
          hasMore,
        };
      }
    }
    if (rows.length < RAW_BATCH_SIZE) break;
  }
  return {
    schema: 'o8/broadcast.events/v1',
    events,
    cursor: encodeCursor(scanCursor),
    hasMore,
  };
}

export function listRecentBroadcastEvents(
  options: ListRecentBroadcastEventsOptions = {},
  sqlite: Database.Database = getSqlite(),
): BroadcastEventPage {
  const limit = normalizeLimit(options.limit);
  const kinds = requestedKinds(options.kinds);
  const events: BroadcastEvent[] = [];
  let scanCursor: RawScanCursor | null = null;
  const headCursor = currentCursor(sqlite);
  let hasMore = false;
  for (;;) {
    const rows = rawRowsBefore(sqlite, scanCursor, RAW_BATCH_SIZE);
    if (rows.length === 0) break;
    for (const row of rows) {
      scanCursor = { timestamp: row.timestamp, rawSource: row.raw_source, ordinal: row.ordinal };
      const event = mapEvent(row, kinds, options.repo, options.lane);
      if (event) events.push(event);
      if (events.length === limit) {
        hasMore = rawRowsBefore(sqlite, scanCursor, 1).length > 0;
        return {
          schema: 'o8/broadcast.events/v1',
          events: events.reverse(),
          cursor: encodeCursor(headCursor),
          hasMore,
        };
      }
    }
    if (rows.length < RAW_BATCH_SIZE) break;
  }
  return {
    schema: 'o8/broadcast.events/v1',
    events: events.reverse(),
    cursor: encodeCursor(headCursor),
    hasMore,
  };
}
