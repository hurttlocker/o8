import { basename } from 'node:path';
import { getDb, getSqlite } from '@/lib/db';
import { matchedTextSnippet } from '@/lib/search/fts';
import type { SearchResult } from '@/lib/search/types';

interface InboxRow {
  id: string;
  repo_path: string;
  packet_id: string | null;
  kind: string;
  payload: string;
  status: string;
  resolution_lane_id: string | null;
  created_at: string;
}

function payloadText(payload: string): { title: string | null; text: string } {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const title = [parsed.title, parsed.packetTitle, parsed.laneLabel, parsed.summary]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? null;
    const text = Object.values(parsed)
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    return { title, text };
  } catch {
    return { title: null, text: payload };
  }
}

export async function searchInbox(query: string): Promise<SearchResult[]> {
  if (!getDb()) return [];
  const rows = getSqlite().prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status,
      resolution_lane_id, created_at
    FROM supervisor_inbox
    WHERE lower(kind || ' ' || payload || ' ' || repo_path || ' '
      || status || ' ' || COALESCE(packet_id, '')) LIKE ?
    ORDER BY CASE status
      WHEN 'human_required' THEN 0 WHEN 'escalated' THEN 1
      WHEN 'pending' THEN 2 ELSE 3 END,
      datetime(created_at) DESC
    LIMIT 8
  `).all(`%${query.toLowerCase()}%`) as InboxRow[];

  return rows.map((row) => {
    const payload = payloadText(row.payload);
    return {
      kind: 'inbox',
      id: `inbox:${row.id}`,
      title: payload.title || row.kind.replace(/_/g, ' '),
      detail: `${basename(row.repo_path)} · ${row.status} · ${matchedTextSnippet(payload.text, query, 100)}`,
      target: {
        inboxItemId: row.id,
        openInbox: true,
        ...(row.packet_id ? { packetId: row.packet_id } : {}),
        ...(row.resolution_lane_id ? { laneId: row.resolution_lane_id } : {}),
      },
      score: 70 + (row.status === 'human_required' ? 20 : row.status === 'escalated' ? 15 : 0),
    } satisfies SearchResult;
  });
}
