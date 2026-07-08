import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { dispatchMission } from '@/lib/orchestrator/operator-mission-service';
import { DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  if (body === null) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const record = asRecord(body) ?? {};
  const missionId = typeof record.missionId === 'string' && record.missionId.trim()
    ? record.missionId.trim()
    : undefined;

  // dispatchMission awaits the full worker launch (Codex spawn + worktree
  // creation), which can take minutes — blocking the HTTP response that whole
  // time. `wait:false` (the CLI default) fires the launch on the persistent Next
  // server and returns once it's initiated; callers track progress via
  // `/api/orchestrator/status`. `wait` defaults to true so the MCP dispatch_mission
  // tool keeps its synchronous dispatched-count contract.
  const wait = record.wait !== false;
  if (!wait) {
    void dispatchMission({ missionId }).catch((error) => {
      console.error('[orchestrator] async dispatch failed:', error instanceof Error ? error.message : error);
    });
    return operatorSuccess({ initiated: true, async: true, missionId: missionId ?? null });
  }

  try {
    const result = await dispatchMission({ missionId });
    return operatorSuccess(result);
  } catch (error) {
    if (error instanceof DispatchPreflightError) {
      return operatorError(error.code, `${error.status.detail} ${error.status.fix}`, 400, {
        runtime: error.status.runtime,
        house: error.status.house,
      });
    }
    const message = error instanceof Error ? error.message : 'Unable to dispatch mission.';
    return operatorError('dispatch_failed', message, 500, error);
  }
}
