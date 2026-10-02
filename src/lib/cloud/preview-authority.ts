import 'server-only';

import { getSqlite } from '@/lib/db';
import { getLane } from '@/lib/lane/registry';
import { getTaskPoolTask } from '@/lib/tasks/pool';
import { getJob, getLatestPacketJob } from './job-queue';
import { listConnectedCloudWorkers } from './worker-presence';
import { listCloudWorkerKeys } from './worker-auth';
import type { RemotePreviewService } from './preview-contract';

export interface PreviewBinding {
  teamId: string;
  taskId: string;
  packetId: string;
  laneId: string;
  jobId: string;
  attempt: number;
  workerId: string;
  workerKeyId: string;
  leaseToken: string;
  manifestHash: string;
  service: RemotePreviewService;
}

/** Persisted lease and latest service receipt remain the authority, never the relay. */
export function previewBindingCurrent(binding: PreviewBinding): boolean {
  const job = getJob(binding.teamId, binding.jobId);
  const latest = getLatestPacketJob(binding.teamId, binding.packetId);
  const lane = getLane(binding.laneId);
  if (!job || latest?.id !== job.id || job.packetId !== binding.packetId || job.claimCount !== binding.attempt
    || job.status !== 'leased' || !(Date.parse(job.leaseExpiresAt ?? '') > Date.now())
    || job.claimedBy !== binding.workerId || job.leaseToken !== binding.leaseToken
    || job.launch.remoteManifestHash !== binding.manifestHash
    || JSON.stringify(job.launch.remotePreview) !== JSON.stringify(binding.service)
    || lane?.runtime !== 'cloud' || lane.packetId !== binding.packetId || lane.sessionKey !== `cloud:${job.sessionId}`
    || !listConnectedCloudWorkers(Date.now(), binding.teamId).some((worker) => worker.workerId === binding.workerId)
    || !listCloudWorkerKeys().some((key) => key.id === binding.workerKeyId && key.teamId === binding.teamId && !key.revokedAt)) return false;
  const service = latestService(binding.jobId, binding.service.name);
  return service?.state === 'healthy' && service.health === true && service.claimCount === binding.attempt
    && service.manifestHash === binding.manifestHash && service.commandId === binding.service.commandId
    && service.port === binding.service.port && service.workerKeyId === binding.workerKeyId;
}

function latestService(jobId: string, name: string): Record<string, unknown> | null {
  const row = getSqlite().prepare(`
    SELECT payload_json FROM cloud_job_events
    WHERE job_id = ? AND event_type = 'service'
      AND json_extract(payload_json, '$.name') = ?
      AND id > (SELECT MAX(id) FROM cloud_job_events WHERE job_id = ? AND event_type = 'claimed')
    ORDER BY id DESC LIMIT 1
  `).get(jobId, name, jobId) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch { return null; }
}

export async function resolveTaskPreview(teamId: string, taskId: string, jobId: string, attempt: number): Promise<PreviewBinding | null> {
  const task = await getTaskPoolTask(taskId);
  const job = getJob(teamId, jobId);
  if (!task?.packetId || !task.laneId || task.execution?.jobId !== jobId || task.execution.attempt !== attempt
    || !job?.launch.remotePreview || !job.launch.remoteManifestHash || !job.claimedBy || !job.leaseToken) return null;
  const service = latestService(jobId, job.launch.remotePreview.name);
  if (typeof service?.workerKeyId !== 'string') return null;
  const binding: PreviewBinding = {
    teamId, taskId, packetId: task.packetId, laneId: task.laneId, jobId, attempt,
    workerId: job.claimedBy, workerKeyId: service.workerKeyId, leaseToken: job.leaseToken, manifestHash: job.launch.remoteManifestHash,
    service: job.launch.remotePreview,
  };
  return previewBindingCurrent(binding) ? binding : null;
}
