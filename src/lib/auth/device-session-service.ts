import 'server-only';

import { NextResponse } from 'next/server';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { queueDeviceRevoke, readPendingDeviceRevokes, removePendingDeviceRevoke } from '@/lib/auth/device-session-store';

export function deviceResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function deviceRequestIsLocal(request: Request): boolean {
  return headersIndicateLoopback((name) => request.headers.get(name));
}

export function requestDeviceService(
  action: 'enroll' | 'renew' | 'revoke', bearer: string, body?: unknown, signal?: AbortSignal,
): Promise<Response> {
  const path = action === 'enroll' ? '/account/device' : `/account/device/${action}`;
  return fetch(`${proxyBaseUrl()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([
      AbortSignal.timeout(action === 'renew' ? 30_000 : 10_000), ...(signal ? [signal] : []),
    ]),
  });
}

let pendingRevokes: Promise<void> | null = null;

/** The private marker survives offline sign-out and contains only pending tokens. */
export function retryPendingDeviceRevokes(): Promise<void> {
  if (!pendingRevokes) {
    pendingRevokes = (async () => {
      for (const token of readPendingDeviceRevokes()) {
        try {
          const response = await requestDeviceService('revoke', token);
          if (response.status === 200 || response.status === 401) removePendingDeviceRevoke(token);
        } catch {
          // Keep the durable intent for the next launch; never log credentials.
        }
      }
    })().finally(() => { pendingRevokes = null; });
  }
  return pendingRevokes;
}

export async function revokeDeviceToken(token: string): Promise<void> {
  queueDeviceRevoke(token);
  await retryPendingDeviceRevokes();
}

export function validDeviceGrant(data: Record<string, unknown>): boolean {
  return typeof data.deviceToken === 'string' && Boolean(data.deviceToken.trim())
    && typeof data.clerkUserId === 'string' && Boolean(data.clerkUserId.trim())
    && typeof data.idleExpiresAt === 'string' && Number.isFinite(Date.parse(data.idleExpiresAt));
}
