import type { NextRequest } from 'next/server';
import { isLocalWorkerToken } from './worker-token';

export type RequestPrincipal = 'operator' | 'worker';

/**
 * Resolve the caller's principal for governance authorization. A dispatched
 * worker presents the local-worker token (O8_WORKER_TOKEN, attached by its
 * `o8` CLI); everything else — the operator webview, the orchestrator MCP
 * (ws-token), a human running `o8` manually — resolves to 'operator'.
 *
 * Conservative by construction: ONLY a positive local-worker token is a worker,
 * so the operator/orchestrator dispatch+merge loop is never mis-denied. See
 * SECURITY_AUDIT_2026-07-02 §CRIT-1 and the two-tier note in worker-token.ts.
 */
export function resolveRequestPrincipal(req: NextRequest): RequestPrincipal {
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const queryToken = req.nextUrl.searchParams.get('token')?.trim() ?? '';
  if (isLocalWorkerToken(bearer) || isLocalWorkerToken(queryToken)) return 'worker';
  return 'operator';
}
