import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { getLatestPacketJob } from '@/lib/cloud/job-queue';
import { getLane } from '@/lib/lane/registry';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getTaskPoolTask } from '@/lib/tasks/pool';
import { readRemoteTaskEvidence } from '@/lib/tasks/remote-evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator') {
    return NextResponse.json({ error: 'Remote task evidence is available in the operator panel.' }, { status: 403, headers });
  }

  const { taskId } = await context.params;
  const jobId = request.nextUrl.searchParams.get('jobId')?.trim() ?? '';
  const attemptValue = request.nextUrl.searchParams.get('attempt')?.trim() ?? '';
  const attempt = Number(attemptValue);
  if (!taskId?.trim() || !jobId || !/^\d+$/.test(attemptValue) || !Number.isSafeInteger(attempt) || attempt < 0) {
    return NextResponse.json({ error: 'Task, job, and attempt are required.' }, { status: 400, headers });
  }

  try {
    const task = await getTaskPoolTask(taskId);
    if (!task) return NextResponse.json({ error: 'Task not found.' }, { status: 404, headers });
    if (!task.packetId || !task.execution || task.execution.jobId !== jobId || task.execution.attempt !== attempt) {
      return NextResponse.json({ error: 'The remote execution changed. Refresh the task before opening evidence.' }, { status: 409, headers });
    }
    const evidence = readRemoteTaskEvidence(DEFAULT_CLOUD_TEAM_ID, jobId, attempt);
    const current = await getTaskPoolTask(taskId);
    // Pool construction awaits project context after reading the job. Re-read
    // durable identity without another await before returning any output.
    const latest = getLatestPacketJob(DEFAULT_CLOUD_TEAM_ID, task.packetId);
    const lane = current?.laneId ? getLane(current.laneId) : null;
    if (!current?.execution || current.packetId !== task.packetId
      || current.execution.jobId !== jobId || current.execution.attempt !== attempt || !evidence.available
      || latest?.id !== jobId || latest.claimCount !== attempt
      || lane?.runtime !== 'cloud' || lane.packetId !== task.packetId || lane.sessionKey !== `cloud:${latest.sessionId}`) {
      return NextResponse.json({ error: 'The remote execution changed. Refresh the task before opening evidence.' }, { status: 409, headers });
    }
    if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
      return NextResponse.json({ error: 'Operator authorization changed. Reconnect before opening evidence.' }, { status: 403, headers });
    }
    return NextResponse.json({
      schema: 'o8/task.remote-evidence/v1',
      packetId: task.packetId,
      jobId,
      attempt,
      status: latest.status,
      leaseState: latest.status !== 'leased' ? 'none' : Date.parse(latest.leaseExpiresAt ?? '') > Date.now() ? 'active' : 'expired',
      logs: evidence.logs,
      files: evidence.files,
      logsTruncated: evidence.logsTruncated,
      filesTruncated: evidence.filesTruncated,
      workspaceAccess: 'unavailable',
      previewAccess: 'unavailable',
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'Unable to read remote task evidence.' }, { status: 500, headers });
  }
}
