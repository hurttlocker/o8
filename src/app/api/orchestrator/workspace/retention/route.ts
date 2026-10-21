import { NextRequest } from 'next/server';

import {
  resolveRequestPrincipal,
  resolveRequestPrincipalContext,
  workerPacketRefusal,
} from '@/lib/auth/principal';
import { bindIdempotencyClientMutation } from '@/lib/orchestrator/idempotency-store';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveMaterializedRecoveryTarget, resolvePacketRecoveryTarget } from '@/lib/workspace/recovery-target';
import {
  acquireWorkspaceRetentionHold,
  releaseWorkspaceRetentionHold,
  type WorkspaceRetentionHold,
} from '@/lib/workspace/retention-holds';
import { getSqlite } from '@/lib/db';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function projectHold(hold: WorkspaceRetentionHold) {
  return {
    holdId: hold.holdId,
    packetId: hold.packetId,
    laneId: hold.laneId,
    reason: hold.reason,
    heldAt: hold.heldAt,
    releasedAt: hold.releasedAt,
    version: hold.version,
    held: hold.releasedAt === null,
  };
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  if (!packetId) return operatorError('invalid_request', 'packetId is required.', 400);
  const refusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
  if (refusal) return operatorError(refusal.code, refusal.message, 403);
  try {
    const { repo } = await resolvePacketRecoveryTarget(packetId);
    const holds = getSqlite().prepare(`
      SELECT hold_id AS holdId, lane_id AS laneId, reason, held_at AS heldAt, version
      FROM workspace_retention_holds
      WHERE repository_uuid = ? AND packet_id = ? AND released_at IS NULL ORDER BY held_at
    `).all(repo.id, packetId);
    return operatorSuccess({ schema: 'o8/workspace-retention/v1', packetId, holds });
  } catch {
    return operatorError('workspace_not_found', 'The managed packet workspace could not be resolved.', 404);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Workspace retention changes are operator-only.', 403);
  }
  const record = asRecord(await parseJsonBody(request));
  const action = record?.action === 'hold' || record?.action === 'release' ? record.action : null;
  const packetId = typeof record?.packetId === 'string' ? record.packetId.trim() : '';
  const clientMutationId = typeof record?.clientMutationId === 'string' ? record.clientMutationId.trim() : '';
  const reason = typeof record?.reason === 'string' ? record.reason.trim() : '';
  const holdId = typeof record?.holdId === 'string' ? record.holdId.trim() : '';
  if (!action || !packetId || !clientMutationId || clientMutationId.length > 256
    || (action === 'hold' && (!reason || reason.length > 1_000))
    || (action === 'release' && (!holdId || holdId.length > 256))) {
    return operatorError('invalid_request', 'Provide action, packetId and clientMutationId; hold needs reason, release needs holdId.', 400);
  }
  try {
    const body = JSON.stringify({ action, packetId, reason: action === 'hold' ? reason : null, holdId: action === 'release' ? holdId : null });
    const binding = bindIdempotencyClientMutation({
      namespace: 'workspace_retention',
      clientKey: clientMutationId,
      body,
    });
    if (binding.status === 'conflict') {
      return operatorError('idempotency_conflict', 'clientMutationId was used for different retention intent.', 409);
    }
    if (binding.status === 'unavailable') {
      return operatorError('idempotency_unavailable', 'The retention receipt store is unavailable; no hold changed.', 503);
    }
    if (action === 'release') {
      const { repo } = await resolvePacketRecoveryTarget(packetId);
      const hold = releaseWorkspaceRetentionHold({ repositoryUuid: repo.id, packetId, holdId });
      return operatorSuccess({ schema: 'o8/workspace-retention/v1', action, hold: projectHold(hold) });
    }
    const target = await resolveMaterializedRecoveryTarget(packetId);
    const hold = acquireWorkspaceRetentionHold({
      repositoryPath: target.repo.localPath,
      repositoryUuid: target.repo.id,
      worktreeId: target.metadata.id,
      packetId,
      laneId: target.lane.id,
      identity: target.identity,
      holdId: clientMutationId,
      reason,
    });
    return operatorSuccess({
      schema: 'o8/workspace-retention/v1',
      action,
      hold: projectHold(hold),
      note: 'Automatic terminal retirement is held until this hold is explicitly released.',
    });
  } catch (error) {
    return operatorError('retention_refused', error instanceof Error ? error.message : 'Workspace retention was refused.', 409);
  }
}
