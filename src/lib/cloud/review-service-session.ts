import 'server-only';

import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { getTaskPoolTask } from '@/lib/tasks/pool';
import { cancelJob, getJob } from './job-queue';
import { SqliteCloudJobStore } from './sqlite-job-store';
import { completedServiceResultSha, expireInvalidServiceSessions, serviceSessionCurrent } from './review-service-authority';
import type { CloudJob } from './job-store';

const LIFETIME_MS = 10 * 60_000;

/** Serialize repeated opens; only the operator's current completed result is eligible. */
export async function ensureReviewServiceJob(teamId: string, taskId: string, parentId: string, attempt: number, expectedServiceId?: string): Promise<CloudJob | null> {
  const task = await getTaskPoolTask(taskId);
  if (!task?.packetId || !task.laneId || task.execution?.jobId !== parentId || task.execution.attempt !== attempt) return null;
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const now = Date.now();
    expireInvalidServiceSessions(sqlite, teamId, now);
    const parent = getJob(teamId, parentId);
    if (parent?.status !== 'completed' || parent.claimCount !== attempt || !parent.launch.remoteSource
      || !parent.launch.remoteManifestHash || !parent.launch.remotePreview) return null;
    const sha = completedServiceResultSha(sqlite, parent.id);
    if (!sha) return null;
    if (expectedServiceId) {
      const expected = getJob(teamId, expectedServiceId);
      return expected?.parentJobId === parentId && expected.launch.remoteServiceSession?.taskId === taskId
        && (expected.status === 'pending' || expected.status === 'leased') ? expected : null;
    }
    const active = sqlite.prepare(`SELECT id FROM cloud_jobs WHERE team_id = ? AND parent_job_id = ?
      AND status IN ('pending', 'leased') AND json_type(launch_json, '$.remoteServiceSession') IS NOT NULL
      ORDER BY cursor DESC LIMIT 1`).get(teamId, parentId) as { id: string } | undefined;
    if (active) return getJob(teamId, active.id) ?? null;
    const count = sqlite.prepare(`SELECT COUNT(*) AS count FROM cloud_jobs WHERE team_id = ?
      AND status IN ('pending', 'leased') AND json_type(launch_json, '$.remoteServiceSession') IS NOT NULL`)
      .get(teamId) as { count: number };
    if (count.count >= 2) throw new Error('Close another review preview before starting this service.');
    const id = `service-${randomUUID()}`;
    const launch = {
      cwd: '', prompt: '', remoteSource: { ...parent.launch.remoteSource, baseSha: sha },
      remoteManifestHash: parent.launch.remoteManifestHash, remotePreview: parent.launch.remotePreview,
      remoteServiceSession: { taskId, packetId: task.packetId!, laneId: task.laneId!,
        parentJobId: parent.id, parentAttempt: attempt, expiresAt: new Date(now + LIFETIME_MS).toISOString() },
    };
    if (!serviceSessionCurrent(sqlite, { id, team_id: teamId, parent_job_id: parentId,
      packet_id: null, launch_json: JSON.stringify(launch), status: 'pending' }, now)) return null;
    return new SqliteCloudJobStore().enqueue({ id, teamId, parentJobId: parentId, sessionId: id,
      idempotencyKey: id, launch, maxAttempts: 1 });
  }).immediate();
}

export function stopReviewServiceJob(teamId: string, taskId: string, serviceJobId: string): boolean {
  const job = getJob(teamId, serviceJobId);
  if (!job?.launch.remoteServiceSession || job.launch.remoteServiceSession.taskId !== taskId) return false;
  cancelJob(teamId, serviceJobId);
  return true;
}
