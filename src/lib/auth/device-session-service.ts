import 'server-only';

import { withAccountStateLease } from './account-state';
import { NextResponse } from 'next/server';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { deleteDeviceSession, invalidateDesktopAuthHandoff, queueDeviceRevoke, readDeviceSession, readPendingDeviceRevokes, removePendingDeviceRevoke } from '@/lib/auth/device-session-store';

export function deviceResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function deviceRequestIsLocal(request: Request): boolean {
  // HTTP has socket truth, not a trusted Tauri window identity. Middleware
  // supplies the operator boundary; renderer window labels cannot strengthen it.
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
      await Promise.all(readPendingDeviceRevokes().map(async (token) => {
        try {
          const response = await requestDeviceService('revoke', token);
          if (response.status === 200 || response.status === 401) removePendingDeviceRevoke(token);
        } catch {
          // Keep the durable intent for the next launch; never log credentials.
        }
      }));
    })().finally(() => { pendingRevokes = null; });
  }
  return pendingRevokes;
}

export async function revokeDeviceToken(token: string): Promise<void> {
  try {
    queueDeviceRevoke(token);
  } catch {
    // This caller holds a certainly-current grant, so a direct attempt is safe.
    await requestDeviceService('revoke', token).catch(() => {});
    return;
  }
  await retryPendingDeviceRevokes();
}

export async function revokeDesktopDeviceSession(): Promise<void> {
  // Durable cancellation precedes every network await, including offline revoke.
  const { session, directRevoke } = await withAccountStateLease(() => {
    invalidateDesktopAuthHandoff();
    const session = readDeviceSession();
    let directRevoke = false;
    try {
      if (session?.renewalStartedAt !== undefined) removePendingDeviceRevoke(session.token);
      else if (session) {
        try { queueDeviceRevoke(session.token); } catch { directRevoke = true; }
      }
    } finally { deleteDeviceSession(); }
    return { session, directRevoke };
  });
  if (directRevoke && session) await requestDeviceService('revoke', session.token).catch(() => {});
  else await retryPendingDeviceRevokes();
}

export function validDeviceGrant(data: Record<string, unknown>): boolean {
  return typeof data.deviceToken === 'string' && Boolean(data.deviceToken.trim())
    && typeof data.clerkUserId === 'string' && Boolean(data.clerkUserId.trim())
    && typeof data.idleExpiresAt === 'string' && Number.isFinite(Date.parse(data.idleExpiresAt));
}
