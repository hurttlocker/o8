import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { stopPacket, stopAllLanes } from '@/lib/orchestrator/stop-packet';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stop / kill an agent (#1286) — the symmetric counterpart to dispatch.
// Body: { packetId } to stop one agent, or { all: true, repoPath? } for a clean
// slate. Always reaps the live runtime process before archiving; never relaunches.
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  try {
    if (record.all === true) {
      const repoPath = typeof record.repoPath === 'string' ? record.repoPath.trim() : undefined;
      const result = await stopAllLanes({ repoPath: repoPath || undefined });
      return operatorSuccess(result);
    }

    const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
    if (!packetId) {
      return operatorError('invalid_request', 'packetId is required (or pass all:true).', 400);
    }
    const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), packetId);
    if (ownershipRefusal) {
      return operatorError(ownershipRefusal.code, ownershipRefusal.message, 403);
    }
    const result = await stopPacket(packetId);
    return operatorSuccess(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to stop agent.';
    return operatorError('stop_failed', message, 500, error);
  }
}
