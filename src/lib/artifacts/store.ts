/**
 * Visual verification artifact store (#1147 phase 1).
 *
 * The universal sink for agent-captured proof (screenshots today, video later).
 * Bytes live on disk under `<dataDir>/artifacts/<packetId>/<id>.<ext>`; metadata
 * lives in the `artifacts` SQLite table. Paths are stored RELATIVE to the data
 * dir so a cloned/relocated install still resolves them — never an absolute
 * `/Users/...` path (clone-readiness rule).
 *
 * Server-side only (touches better-sqlite3 + fs). The agent-facing `o8 packet
 * capture` CLI never imports this — it POSTs bytes to /api/panel/artifacts,
 * which calls in here.
 */

import { and, asc, eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, artifacts } from '@/lib/db';
import { getDataDir } from '@/lib/data-dir-migration';

export type ArtifactKind = 'screenshot' | 'video' | 'report' | 'receipt';
export type ArtifactSource = 'agent-capture' | 'review-boundary' | 'manual';
export type ArtifactPhase = 'before' | 'after' | null;

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  laneId: string | null;
  packetId: string | null;
  repoPath: string | null;
  prNumber: number | null;
  threadId: string | null;
  label: string | null;
  phase: ArtifactPhase;
  pairId: string | null;
  relPath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  ghCommentUrl: string | null;
  capturedAt: string;
  createdAt: string;
}

export interface NewArtifactInput {
  /** Optional explicit id so the on-disk filename matches the DB row id. */
  id?: string;
  kind?: ArtifactKind;
  source: ArtifactSource;
  relPath: string;
  laneId?: string | null;
  packetId?: string | null;
  repoPath?: string | null;
  prNumber?: number | null;
  threadId?: string | null;
  label?: string | null;
  phase?: ArtifactPhase;
  pairId?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'text/html': 'html',
  'application/json': 'json',
};

/** Filesystem-safe slug for a path segment (packet ids can contain `/` or `:`). */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'misc';
}

export function artifactExtForMime(mimeType: string | null | undefined): string {
  return EXT_BY_MIME[(mimeType ?? '').toLowerCase()] ?? 'png';
}

/** New artifact id (caller writes bytes to artifactAbsPath(relPathFor(...))). */
export function newArtifactId(): string {
  return `art-${randomUUID()}`;
}

/** Relative-to-dataDir path for an artifact, e.g. `artifacts/<packet>/<id>.png`. */
export function artifactRelPath(packetId: string | null | undefined, id: string, ext: string): string {
  const bucket = safeSegment(packetId?.trim() || 'unassigned');
  return join('artifacts', bucket, `${id}.${ext}`);
}

/** Absolute on-disk path for a stored relative path. */
export function artifactAbsPath(relPath: string): string {
  return join(getDataDir(), relPath);
}

/** Ensure the on-disk bucket exists; returns the absolute dir. */
export function ensureArtifactBucket(packetId: string | null | undefined): string {
  const dir = join(getDataDir(), 'artifacts', safeSegment(packetId?.trim() || 'unassigned'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Serve URL for the still/media — reuses the existing loopback-gated route. */
export function artifactServeUrl(relPath: string): string {
  return `/api/panel/serve-image?path=${encodeURIComponent(artifactAbsPath(relPath))}`;
}

/**
 * Insert an artifact row. Bytes must already be written to
 * `artifactAbsPath(input.relPath)`. Returns the record, or null if the DB is
 * unavailable (bundle without better-sqlite3) — callers must not throw.
 */
export function recordArtifact(input: NewArtifactInput): ArtifactRecord | null {
  const db = getDb();
  if (!db) return null;

  const id = input.id ?? newArtifactId();
  const now = new Date().toISOString();
  const row = {
    id,
    kind: input.kind ?? 'screenshot',
    source: input.source,
    laneId: input.laneId ?? null,
    packetId: input.packetId ?? null,
    repoPath: input.repoPath ?? null,
    prNumber: input.prNumber ?? null,
    threadId: input.threadId ?? null,
    label: input.label ?? null,
    phase: input.phase ?? null,
    pairId: input.pairId ?? null,
    relPath: input.relPath,
    mimeType: input.mimeType ?? 'image/png',
    width: input.width ?? null,
    height: input.height ?? null,
    bytes: input.bytes ?? null,
    ghCommentUrl: null,
    capturedAt: now,
    createdAt: now,
  };

  try {
    db.insert(artifacts).values(row).run();
  } catch (err) {
    console.warn('[artifacts] recordArtifact insert failed', err);
    return null;
  }
  return row as ArtifactRecord;
}

/** Fetch a single artifact row by id. Null when absent or the DB is down. */
export function getArtifact(id: string): ArtifactRecord | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return (row as ArtifactRecord | undefined) ?? null;
  } catch (err) {
    console.warn('[artifacts] getArtifact query failed', err);
    return null;
  }
}

export interface ListArtifactsFilter {
  packetId?: string | null;
  prNumber?: number | null;
  laneId?: string | null;
  threadId?: string | null;
}

/**
 * List artifacts for a packet / PR / lane / thread, oldest-first (so a `before`
 * naturally precedes its `after`). Returns [] when no filter key is provided or
 * the DB is unavailable. AND-combines provided keys.
 */
export function listArtifacts(filter: ListArtifactsFilter): ArtifactRecord[] {
  const db = getDb();
  if (!db) return [];

  const clauses = [];
  if (filter.packetId) clauses.push(eq(artifacts.packetId, filter.packetId));
  if (typeof filter.prNumber === 'number') clauses.push(eq(artifacts.prNumber, filter.prNumber));
  if (filter.laneId) clauses.push(eq(artifacts.laneId, filter.laneId));
  if (filter.threadId) clauses.push(eq(artifacts.threadId, filter.threadId));
  if (clauses.length === 0) return [];

  try {
    const rows = db
      .select()
      .from(artifacts)
      .where(clauses.length === 1 ? clauses[0] : and(...clauses))
      .orderBy(asc(artifacts.capturedAt), asc(artifacts.createdAt))
      .all();
    return rows as ArtifactRecord[];
  } catch (err) {
    console.warn('[artifacts] listArtifacts query failed', err);
    return [];
  }
}

/** Set the GitHub comment URL once an artifact has been mirrored to a PR. */
export function stampArtifactGhComment(id: string, ghCommentUrl: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.update(artifacts).set({ ghCommentUrl }).where(eq(artifacts.id, id)).run();
  } catch (err) {
    console.warn('[artifacts] stampArtifactGhComment failed', err);
  }
}

export interface ArtifactView extends ArtifactRecord {
  /** Loopback serve URL for the still/media. */
  url: string;
}

/** Attach the serve URL — the shape the API/WS/UI consume (never raw disk paths). */
export function toArtifactView(record: ArtifactRecord): ArtifactView {
  return { ...record, url: artifactServeUrl(record.relPath) };
}

export interface ArtifactRef {
  id: string;
  url: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  phase: ArtifactPhase;
  pairId: string | null;
  label: string | null;
  width: number | null;
  height: number | null;
  capturedAt: string;
}

/**
 * Slim reference for the orchestrator / mission-status payload + WS broadcasts —
 * everything the UI needs to render a strip, with NO raw disk path or repoPath.
 */
export function toArtifactRef(record: ArtifactRecord): ArtifactRef {
  return {
    id: record.id,
    url: artifactServeUrl(record.relPath),
    kind: record.kind,
    source: record.source,
    phase: record.phase,
    pairId: record.pairId,
    label: record.label,
    width: record.width,
    height: record.height,
    capturedAt: record.capturedAt,
  };
}
