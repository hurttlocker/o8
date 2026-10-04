import 'server-only';

import { NextResponse } from 'next/server';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

export function deviceResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function deviceRequestIsLocal(request: Request): boolean {
  return headersIndicateLoopback((name) => request.headers.get(name));
}

export function requestDeviceService(
  action: 'enroll' | 'renew' | 'revoke', bearer: string, body?: unknown,
): Promise<Response> {
  const path = action === 'enroll' ? '/account/device' : `/account/device/${action}`;
  return fetch(`${proxyBaseUrl()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

export function validDeviceGrant(data: Record<string, unknown>): boolean {
  return typeof data.deviceToken === 'string' && Boolean(data.deviceToken.trim())
    && typeof data.clerkUserId === 'string' && Boolean(data.clerkUserId.trim())
    && typeof data.idleExpiresAt === 'string' && Number.isFinite(Date.parse(data.idleExpiresAt));
}
