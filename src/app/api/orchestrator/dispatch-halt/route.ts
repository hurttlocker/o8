import { NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readDispatchHaltState, setDispatchHaltState } from '@/lib/orchestrator/dispatch-halt';
import { stopAllActiveMissions } from '@/lib/orchestrator/mission-stop';
import { requirePanelAuth } from '@/lib/panel/auth';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    return operatorSuccess(readDispatchHaltState());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read dispatch halt state.';
    return operatorError('dispatch_halt_read_failed', message, 500, error);
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Dispatch halt is operator-only; a dispatched worker cannot call this.', 403);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const verb = typeof record.verb === 'string' ? record.verb.trim() : '';
  const stopRunning = record.stopRunning === true;
  const reason = typeof record.reason === 'string' ? record.reason.trim() : null;

  try {
    if (verb === 'halt') {
      const halt = setDispatchHaltState(true, reason);
      const stopped = stopRunning ? await stopAllActiveMissions() : null;
      return operatorSuccess({ halt, stopped });
    }
    if (verb === 'resume') {
      const halt = setDispatchHaltState(false);
      return operatorSuccess({ halt });
    }
    return operatorError('invalid_request', 'verb must be halt or resume.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update dispatch halt state.';
    return operatorError('dispatch_halt_failed', message, 500, error);
  }
}
