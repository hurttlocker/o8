import 'server-only';

import path from 'node:path';

import { getSqlite } from '@/lib/db';

const MAX_LOG_EVENTS = 80;
const MAX_LOG_CHARS = 32_000;
const MAX_LOG_EVENT_CHARS = 2_000;
const MAX_FILES = 100;

interface EventRow {
  id: number;
  payload_json: string;
  created_at: string;
}

export interface RemoteTaskEvidence {
  logs: { id: number; text: string; createdAt: string }[];
  files: { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number }[];
  logsTruncated: boolean;
  filesTruncated: boolean;
  available: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parsePayload(value: string): Record<string, unknown> | null {
  try { return record(JSON.parse(value)); } catch { return null; }
}

function cleanLogText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .slice(0, MAX_LOG_EVENT_CHARS);
}

function safeRelativeFile(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || !value || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (path.posix.isAbsolute(value) || value.split('/').some((part) => part === '..' || part === '.')) return null;
  return value;
}

/** Read only the latest claim's bounded output; an older claim is never current evidence. */
export function readRemoteTaskEvidence(teamId: string, jobId: string, attempt: number): RemoteTaskEvidence {
  const database = getSqlite();
  return database.transaction(() => {
    const claim = database.prepare(`
      SELECT COUNT(*) AS count, MAX(event.id) AS last_id
      FROM cloud_job_events event
      JOIN cloud_jobs job ON job.id = event.job_id
      WHERE job.team_id = ? AND job.id = ? AND event.event_type = 'claimed'
    `).get(teamId, jobId) as { count: number; last_id: number | null };
    const empty = { logs: [], files: [], logsTruncated: false, filesTruncated: false, available: false } satisfies RemoteTaskEvidence;
    if (claim.count !== attempt) return empty;
    if (attempt === 0) return { ...empty, available: true };
    const sinceId = claim.last_id ?? 0;
    const rows = database.prepare(`
      SELECT event.id, event.payload_json, event.created_at
      FROM cloud_job_events event
      JOIN cloud_jobs job ON job.id = event.job_id
      WHERE job.team_id = ? AND job.id = ? AND event.id > ? AND event.event_type = 'chunk'
      ORDER BY event.id DESC LIMIT ?
    `).all(teamId, jobId, sinceId, MAX_LOG_EVENTS + 1) as EventRow[];
    const logs: RemoteTaskEvidence['logs'] = [];
    let chars = 0;
    let logsTruncated = rows.length > MAX_LOG_EVENTS;
    for (const row of rows.slice(0, MAX_LOG_EVENTS)) {
      const payload = parsePayload(row.payload_json);
      if (typeof payload?.text !== 'string') continue;
      const text = cleanLogText(payload.text);
      const room = MAX_LOG_CHARS - chars;
      if (room <= 0) { logsTruncated = true; break; }
      logs.push({ id: row.id, text: text.slice(0, room), createdAt: row.created_at });
      chars += text.length;
      if (text.length > room || payload.text.length > MAX_LOG_EVENT_CHARS) logsTruncated = true;
    }
    logs.reverse();

    const diff = database.prepare(`
      SELECT event.id, event.payload_json, event.created_at
      FROM cloud_job_events event
      JOIN cloud_jobs job ON job.id = event.job_id
      WHERE job.team_id = ? AND job.id = ? AND event.id > ? AND event.event_type = 'diff'
      ORDER BY event.id DESC LIMIT 1
    `).get(teamId, jobId, sinceId) as EventRow | undefined;
    const rawFiles = parsePayload(diff?.payload_json ?? '')?.files;
    const files: RemoteTaskEvidence['files'] = [];
    if (Array.isArray(rawFiles)) {
      for (const rawFile of rawFiles.slice(0, MAX_FILES)) {
        const file = record(rawFile);
        const filePath = safeRelativeFile(file?.path);
        if (!filePath || !['added', 'modified', 'deleted', 'renamed'].includes(String(file?.status))
          || !Number.isSafeInteger(file?.additions) || Number(file?.additions) < 0
          || !Number.isSafeInteger(file?.deletions) || Number(file?.deletions) < 0) continue;
        files.push({ path: filePath, status: file!.status as RemoteTaskEvidence['files'][number]['status'], additions: Number(file!.additions), deletions: Number(file!.deletions) });
      }
    }
    return { logs, files, logsTruncated, filesTruncated: Array.isArray(rawFiles) && rawFiles.length > MAX_FILES, available: true };
  }).immediate();
}
