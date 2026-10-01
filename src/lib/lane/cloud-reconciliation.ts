import 'server-only';
import { getLatestPacketJob } from '@/lib/cloud/job-queue';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { attachSession, listLanes, setLaneStatus } from './registry';
import type { LaneStatus } from './types';

/** Durable jobs, not the local CLI process inventory, own remote liveness. */
export function reconcileCloudJobLanes(): void {
  for (const lane of listLanes()) {
    if (lane.runtime !== 'cloud' || !lane.packetId
      || ['completed', 'archived', 'merging', 'reviewing', 'failed', 'awaiting_input', 'awaiting_orchestrator', 'awaiting_human'].includes(lane.status)
      || (lane.status === 'paused' && lane.lastEventLabel !== 'session_lost')) continue;
    const job = getLatestPacketJob(DEFAULT_CLOUD_TEAM_ID, lane.packetId);
    if (!job || job.launch.laneId !== lane.id || job.launch.branchName !== lane.branch) continue;
    const sessionKey = `cloud:${job.sessionId}`;
    if (lane.sessionKey !== sessionKey) {
      // Repair only a binding the local inventory incorrectly discarded.
      if (lane.sessionKey || lane.lastEventLabel !== 'session_lost') continue;
      attachSession(lane.id, sessionKey);
    }
    const status: LaneStatus = job.status === 'completed' ? 'reviewing'
      : job.status === 'parked' ? 'failed'
      : job.status === 'cancelled' ? 'paused'
      : job.status === 'pending' ? 'launching'
      : job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) > Date.now() ? 'running' : 'recovering';
    if (lane.status !== status) setLaneStatus(lane.id, status, 'system', `remote_job_${job.status}`);
  }
}
