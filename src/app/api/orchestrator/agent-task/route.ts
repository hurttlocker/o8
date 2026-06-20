import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import { performRuntimeAction } from '@/lib/runtime/actions';
import { codename } from '@/lib/agents/codename';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Voice "[Name], [task]" — address a WORKING agent by the memorable codename on
 * its canvas card and steer it with a follow-up (the demo's name-addressing).
 *
 * Codenames are deterministic on the lane id (codename.ts is the single source of
 * truth — the same pure function labels the card on the client and resolves the
 * spoken name here on the server, so the name you SEE is the name you can SAY; no
 * shared map to drift). Steering reuses the warm session (layer-3, ~1 turn); the
 * card's phase updates live via the lane watcher.
 *
 * Body: { name, task }
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const task = typeof record.task === 'string' ? record.task.trim()
    : typeof record.message === 'string' ? record.message.trim()
    : '';
  if (!name) {
    return operatorError('invalid_request', 'name is required (the agent\'s canvas name, e.g. "Atlas").', 400);
  }
  if (!task) {
    return operatorError('invalid_request', 'task is required (what to tell the agent).', 400);
  }

  const lanes = listActiveLanesWithSessions();
  const roster = [...new Set(lanes.map((lane) => codename(lane.id)))];
  const target = name.toLowerCase();
  const matches = lanes.filter((lane) => codename(lane.id).toLowerCase() === target);

  // These are conversational outcomes the operator should HEAR, not transport
  // errors — return 200 so the voice tool reads the spoken message back cleanly
  // (a non-2xx body comes through as a messy "error (404): {json}" string).
  if (matches.length === 0) {
    return operatorError(
      'no_such_agent',
      roster.length
        ? `No agent named "${name}" is working. Working now: ${roster.join(', ')}.`
        : `No agent named "${name}" — no agents are working right now.`,
      200,
    );
  }
  // Codenames hash from a 24-name pool, so a rare collision is possible with a
  // big fleet. Don't guess which one — ask the operator to steer it from its card.
  if (matches.length > 1) {
    return operatorError(
      'ambiguous_agent',
      `More than one agent is named "${name}" right now — steer the one you mean from its card.`,
      200,
    );
  }

  const lane = matches[0];
  const resolvedName = codename(lane.id);
  if (!lane.sessionKey) {
    return operatorError('no_session', `${resolvedName} has no steerable session — it may have finished.`, 200);
  }

  const result = await performRuntimeAction({ action: 'steer', surfaceId: lane.sessionKey, message: task });
  if (!result.ok) {
    return operatorError('steer_failed', result.note || `Could not reach ${resolvedName}.`, 200);
  }

  return operatorSuccess({
    steered: resolvedName,
    laneId: lane.id,
    runtime: result.runtime,
    note: `told ${resolvedName}: ${task}`,
  });
}
