import 'server-only';
import { getSqlite } from '@/lib/db';
import type { VisualizationDocument, VisualizationReference } from './types';
import { VisualizationError } from './errors';

interface VisualizationRow {
  id: string;
  title: string;
  html?: string;
  height: number;
  repo_path: string;
  thread_id: string | null;
  packet_id: string | null;
  created_at: string;
  root_id?: string;
  parent_id?: string | null;
  version?: number;
  source?: string;
}

function reference(row: VisualizationRow): VisualizationReference {
  return { kind: 'o8-visualization', id: row.id, title: row.title, height: row.height, createdAt: row.created_at,
    ...(row.root_id ? { rootId: row.root_id, version: row.version, ...(row.parent_id ? { parentId: row.parent_id } : {}) } : {}) };
}

export function insertVisualization(doc: VisualizationDocument): void {
  const db = getSqlite();
  db.transaction(() => {
    if (doc.parentId && latestVisualizationId(doc.rootId!) !== doc.parentId) throw new VisualizationError('revision_conflict', 'A newer revision exists. Read it before revising again.', 409);
    db.prepare(`INSERT INTO transcript_visualizations
    (id, title, html, height, repo_path, thread_id, packet_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(doc.id, doc.title, doc.html, doc.height, doc.repoPath, doc.threadId, doc.packetId, doc.createdAt);
    if (doc.source) db.prepare(`INSERT INTO transcript_visualization_versions (id,root_id,parent_id,version,source) VALUES (?,?,?,?,?)`)
      .run(doc.id, doc.rootId ?? doc.id, doc.parentId ?? null, doc.version ?? 1, JSON.stringify(doc.source));
  }).immediate();
}

export function getVisualization(id: string): VisualizationDocument | null {
  const row = getSqlite().prepare(`SELECT v.*,m.root_id,m.parent_id,m.version,m.source FROM transcript_visualizations v
    LEFT JOIN transcript_visualization_versions m ON m.id=v.id WHERE v.id = ?`).get(id) as VisualizationRow | undefined;
  return row ? { ...reference(row), html: row.html!, repoPath: row.repo_path, threadId: row.thread_id, packetId: row.packet_id,
    ...(row.source ? { source: JSON.parse(row.source) as VisualizationDocument['source'] } : {}) } : null;
}

export function getVisualizationMetadata(id: string): Omit<VisualizationDocument, 'html' | 'source'> | null {
  const row = getSqlite().prepare(`SELECT v.id,v.title,v.height,v.repo_path,v.thread_id,v.packet_id,v.created_at,m.root_id,m.parent_id,m.version
    FROM transcript_visualizations v LEFT JOIN transcript_visualization_versions m ON m.id=v.id WHERE v.id=?`).get(id) as VisualizationRow | undefined;
  return row ? { ...reference(row), repoPath: row.repo_path, threadId: row.thread_id, packetId: row.packet_id } : null;
}

export function latestVisualizationId(rootId: string): string {
  const row = getSqlite().prepare('SELECT id FROM transcript_visualization_versions WHERE root_id=? ORDER BY version DESC LIMIT 1')
    .get(rootId) as { id: string } | undefined;
  return row?.id ?? rootId;
}

export function visualizationVersions(rootId: string): VisualizationReference[] {
  return (getSqlite().prepare(`SELECT v.id,v.title,v.height,v.created_at,m.root_id,m.parent_id,m.version FROM transcript_visualizations v
    LEFT JOIN transcript_visualization_versions m ON m.id=v.id WHERE v.id=? OR m.root_id=? ORDER BY COALESCE(m.version,1) DESC LIMIT 50`)
    .all(rootId, rootId) as VisualizationRow[]).map(reference);
}

/** Poll metadata only; large documents load individually when they enter the viewport. */
export function listVisualizations(target: { repoPath: string; threadId: string | null; packetId: string | null }): VisualizationReference[] {
  const query = `SELECT v.id,v.title,v.height,v.repo_path,v.thread_id,v.packet_id,COALESCE(r.created_at,v.created_at) AS created_at,m.root_id,m.parent_id,m.version
    FROM transcript_visualizations v LEFT JOIN transcript_visualization_versions m ON m.id=v.id LEFT JOIN transcript_visualizations r ON r.id=m.root_id
    WHERE ${target.packetId ? 'v.packet_id=?' : 'v.repo_path=? AND v.thread_id=?'} AND NOT EXISTS
    (SELECT 1 FROM transcript_visualization_versions newer WHERE newer.root_id=COALESCE(m.root_id,v.id) AND newer.version>COALESCE(m.version,1))
    ORDER BY COALESCE(r.created_at,v.created_at) DESC,v.id DESC LIMIT 100`;
  const rows = getSqlite().prepare(query).all(...(target.packetId ? [target.packetId] : [target.repoPath, target.threadId])) as VisualizationRow[];
  return rows.reverse().map(reference);
}
