import { getDb, getSqlite } from '@/lib/db';
import { matchedTextSnippet } from '@/lib/search/fts';
import type { SearchResult } from '@/lib/search/types';

interface ApprovalRow {
  id: string;
  title: string;
  description: string;
  summary: string;
  risk: string;
  status: string;
  agent: string;
  packet_id: string | null;
  lane_id: string | null;
  session_key: string;
  created_at: number;
}

export async function searchApprovals(query: string): Promise<SearchResult[]> {
  if (!getDb()) return [];
  const needle = `%${query.toLowerCase()}%`;
  const rows = getSqlite().prepare(`
    SELECT id, title, description, summary, risk, status, agent, packet_id,
      lane_id, session_key, created_at
    FROM approvals
    WHERE lower(title || ' ' || description || ' ' || summary || ' '
      || COALESCE(tool_name, '') || ' ' || COALESCE(command, '') || ' '
      || agent || ' ' || session_key) LIKE ?
    ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 8
  `).all(needle) as ApprovalRow[];

  return rows.map((row) => ({
    kind: 'approval',
    id: `approval:${row.id}`,
    title: row.title,
    detail: `${row.status} · ${row.risk} risk · ${matchedTextSnippet(row.summary || row.description, query, 110)}`,
    target: {
      approvalId: row.id,
      openInbox: true,
      ...(row.packet_id ? { packetId: row.packet_id } : {}),
      ...(row.lane_id ? { laneId: row.lane_id } : {}),
      ...(row.session_key ? { sessionKey: row.session_key } : {}),
    },
    score: 75 + (row.status === 'pending' ? 20 : 0),
  }));
}
