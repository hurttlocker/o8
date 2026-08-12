import { NextResponse } from 'next/server';

const JSON_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };
const LOG_PREFIX = '[mcp-operator]';

export function operatorSuccess<T>(result: T, status = 200) {
  return NextResponse.json({ ok: true, result }, {
    status,
    headers: JSON_HEADERS,
  });
}

export function operatorError(code: string, message: string, status = 500, details?: unknown) {
  if (details === undefined) {
    console.error(`${LOG_PREFIX} ${code}: ${message}`);
  } else {
    console.error(`${LOG_PREFIX} ${code}: ${message}`, details);
  }

  return NextResponse.json({
    ok: false,
    error: {
      code,
      message,
    },
  }, {
    status,
    headers: JSON_HEADERS,
  });
}

export async function parseJsonBody(request: Request) {
  try {
    return await request.json() as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Shape an idempotency outcome (#1497) for `operatorSuccess`. A fresh
 * execution returns the raw result; a replay stamps `replayed:true` (and
 * `inProgress:true` for a duplicate that raced the still-running original) so
 * callers can distinguish a re-executed call from a deduped one.
 */
export function replayShape<T>(outcome: { replayed: boolean; inProgress: boolean; result: T }): unknown {
  if (!outcome.replayed) return outcome.result;
  const base: Record<string, unknown> = outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result)
    ? { ...(outcome.result as Record<string, unknown>) }
    : { result: outcome.result };
  base.replayed = true;
  if (outcome.inProgress) base.inProgress = true;
  return base;
}

export function unresolvedIdempotencyResponse(outcome: { unresolved?: boolean }, action: string) {
  if (!outcome.unresolved) return null;
  return operatorError(
    'outcome_unknown',
    `The prior ${action} process ended before its receipt was persisted. Its outcome is unknown, so the exact mutation remains quarantined and was not repeated. Inspect current state before taking another action.`,
    409,
  );
}
