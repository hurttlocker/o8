import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';

export interface BroadcastAttentionReceipt {
  id: string;
  utterance: string;
  toldAt: string;
  heardAt: string;
  trigger: string | null;
  reason: string;
  sources: Array<{
    id: string;
    kind: string;
    title: string;
    detail: string | null;
    timestamp: string;
    laneId: string | null;
    packetId: string | null;
  }>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseSources(value: unknown): BroadcastAttentionReceipt['sources'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = record(item);
    const id = text(source?.id);
    const kind = text(source?.kind);
    const title = text(source?.title);
    const timestamp = text(source?.timestamp);
    if (!id || !kind || !title || !timestamp) return [];
    return [{
      id,
      kind,
      title,
      detail: text(source?.detail),
      timestamp,
      laneId: text(source?.laneId),
      packetId: text(source?.packetId),
    }];
  });
}

export function latestBroadcastAttentionReceipt(
  sqlite: Database.Database = getSqlite(),
): BroadcastAttentionReceipt | null {
  ensureV44BroadcastSchema(sqlite);
  const row = sqlite.prepare(`
    SELECT id, text, metadata_json AS metadata, created_at AS createdAt
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND json_extract(metadata_json, '$.speechHeardAt') IS NOT NULL
    ORDER BY json_extract(metadata_json, '$.speechHeardAt') DESC, sequence DESC
    LIMIT 1
  `).get() as { id: string; text: string; metadata: string; createdAt: string } | undefined;
  if (!row) return null;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = record(JSON.parse(row.metadata)) ?? {};
  } catch {
    metadata = {};
  }
  const provenance = record(metadata.provenance);
  return {
    id: row.id,
    utterance: row.text,
    toldAt: row.createdAt,
    heardAt: text(metadata.speechHeardAt) ?? row.createdAt,
    trigger: text(metadata.voiceTrigger) ?? (metadata.onDemand === true ? 'on-demand' : null),
    reason: text(provenance?.reason)
      ?? (metadata.onDemand === true
        ? 'The operator explicitly requested this spoken line.'
        : 'This line was posted to the subscribed Broadcast voice feed.'),
    sources: parseSources(provenance?.sources),
  };
}
