import type Database from 'better-sqlite3';
import type { LaunchOptions } from '@/lib/runtimes/types';
import { listCloudWorkerKeys } from './worker-auth';
import { cancelCloudJob } from './sqlite-job-control';

interface ServiceRow {
  id: string; team_id: string; parent_job_id: string | null; packet_id: string | null;
  launch_json: string; status: string;
}

function launch(row: ServiceRow): LaunchOptions {
  try { return JSON.parse(row.launch_json) as LaunchOptions; } catch { return { prompt: '', cwd: '' }; }
}

export function serviceSessionDeadline(launchJson: string): number {
  const marker = launch({ launch_json: launchJson } as ServiceRow).remoteServiceSession;
  return marker ? Date.parse(marker.expiresAt) : Infinity;
}

/** The result remains authoritative; a child may only serve its exact revision. */
export function serviceSessionCurrent(sqlite: Database.Database, row: ServiceRow, nowMs = Date.now()): boolean {
  const child = launch(row);
  const marker = child.remoteServiceSession;
  if (!marker) return true;
  if (!marker.taskId || !marker.packetId || !marker.laneId || marker.parentJobId !== row.parent_job_id
    || row.packet_id || child.packetId || !Number.isSafeInteger(marker.parentAttempt) || marker.parentAttempt < 1
    || !(Date.parse(marker.expiresAt) > nowMs)) return false;
  const claim = sqlite.prepare(`SELECT payload_json FROM cloud_job_events WHERE job_id = ? AND event_type = 'claimed'
    ORDER BY id DESC LIMIT 1`).get(row.id) as { payload_json: string } | undefined;
  if (claim) {
    try {
      const keyId = JSON.parse(claim.payload_json).workerKeyId;
      if (!listCloudWorkerKeys().some((key) => key.id === keyId && key.teamId === row.team_id && !key.revokedAt)) return false;
    } catch { return false; }
  }
  const parent = sqlite.prepare(`SELECT * FROM cloud_jobs WHERE team_id = ? AND id = ?
    AND status = 'completed' AND packet_id = ? AND claim_count = ?`).get(
    row.team_id, marker.parentJobId, marker.packetId, marker.parentAttempt,
  ) as (ServiceRow & { session_id: string }) | undefined;
  const latest = sqlite.prepare('SELECT id FROM cloud_jobs WHERE team_id = ? AND packet_id = ? ORDER BY cursor DESC LIMIT 1')
    .get(row.team_id, marker.packetId) as { id: string } | undefined;
  const lane = sqlite.prepare('SELECT runtime, packet_id, session_key, status, outcome FROM lanes WHERE id = ?')
    .get(marker.laneId) as { runtime: string; packet_id: string; session_key: string; status: string; outcome: string | null } | undefined;
  if (!parent || latest?.id !== parent.id || lane?.runtime !== 'cloud' || lane.packet_id !== marker.packetId
    || lane.session_key !== `cloud:${parent.session_id}` || lane.status === 'archived' || lane.outcome) return false;
  const original = launch(parent);
  const sha = completedServiceResultSha(sqlite, parent.id);
  return sha !== null
    && child.remoteSource?.baseSha === sha && child.remoteSource.repoUrl === original.remoteSource?.repoUrl
    && child.remoteManifestHash === original.remoteManifestHash && Boolean(child.remoteManifestHash)
    && Boolean(child.remotePreview) && JSON.stringify(child.remotePreview) === JSON.stringify(original.remotePreview);
}

export function completedServiceResultSha(sqlite: Database.Database, jobId: string): string | null {
  const completion = sqlite.prepare(`SELECT payload_json FROM cloud_job_events WHERE job_id = ? AND event_type = 'completed'
    AND id > (SELECT MAX(id) FROM cloud_job_events WHERE job_id = ? AND event_type = 'claimed') ORDER BY id DESC LIMIT 1`)
    .get(jobId, jobId) as { payload_json: string } | undefined;
  try {
    const sha: unknown = JSON.parse(completion?.payload_json ?? '{}').commitSha;
    return typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
  } catch { return null; }
}

export function expireInvalidServiceSessions(sqlite: Database.Database, teamId: string, nowMs: number): void {
  const rows = sqlite.prepare(`SELECT * FROM cloud_jobs WHERE team_id = ? AND status IN ('pending', 'leased')
    AND json_type(launch_json, '$.remoteServiceSession') IS NOT NULL`).all(teamId) as ServiceRow[];
  for (const row of rows) {
    if (!serviceSessionCurrent(sqlite, row, nowMs)) cancelCloudJob(sqlite, row, nowMs, { reason: 'service_session_ended' });
  }
}

/** The claim records its credential on the server, independently of worker IDs. */
export function workerClaimKeyCurrent(sqlite: Database.Database, jobId: string, keyId: string): boolean {
  const row = sqlite.prepare(`SELECT payload_json FROM cloud_job_events WHERE job_id = ? AND event_type = 'claimed'
    ORDER BY id DESC LIMIT 1`).get(jobId) as { payload_json: string } | undefined;
  try {
    const key = JSON.parse(row?.payload_json ?? '{}').workerKeyId;
    const job = sqlite.prepare('SELECT launch_json FROM cloud_jobs WHERE id = ?').get(jobId) as { launch_json: string } | undefined;
    return key === keyId || (key === undefined && !job?.launch_json.includes('"remoteServiceSession"'));
  } catch { return false; }
}
