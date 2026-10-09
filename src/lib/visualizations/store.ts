import 'server-only';
import { getSqlite } from '@/lib/db';
import type { VisualizationDocument, VisualizationReference } from './types';

interface VisualizationRow {
  id: string;
  title: string;
  html?: string;
  height: number;
  repo_path: string;
  thread_id: string | null;
  packet_id: string | null;
  created_at: string;
}

function reference(row: VisualizationRow): VisualizationReference {
  return { kind: 'o8-visualization', id: row.id, title: row.title, height: row.height, createdAt: row.created_at };
}

export function insertVisualization(doc: VisualizationDocument): void {
  getSqlite().prepare(`INSERT INTO transcript_visualizations
    (id, title, html, height, repo_path, thread_id, packet_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(doc.id, doc.title, doc.html, doc.height, doc.repoPath, doc.threadId, doc.packetId, doc.createdAt);
}

export function getVisualization(id: string): VisualizationDocument | null {
  const row = getSqlite().prepare('SELECT * FROM transcript_visualizations WHERE id = ?').get(id) as VisualizationRow | undefined;
  return row ? { ...reference(row), html: row.html!, repoPath: row.repo_path, threadId: row.thread_id, packetId: row.packet_id } : null;
}

/** Poll metadata only; large documents load individually when they enter the viewport. */
export function listVisualizations(target: { repoPath: string; threadId: string | null; packetId: string | null }): VisualizationReference[] {
  const columns = 'id, title, height, repo_path, thread_id, packet_id, created_at';
  const rows = (target.packetId
    ? getSqlite().prepare(`SELECT ${columns} FROM transcript_visualizations WHERE packet_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).all(target.packetId)
    : getSqlite().prepare(`SELECT ${columns} FROM transcript_visualizations WHERE repo_path = ? AND thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`).all(target.repoPath, target.threadId)) as VisualizationRow[];
  return rows.reverse().map(reference);
}
