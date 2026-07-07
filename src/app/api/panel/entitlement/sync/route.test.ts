import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.fn();
const clearCachedEntitlementMock = vi.fn();
const clearFounderRecordMock = vi.fn();
const getEntitlementMock = vi.fn(async () => ({ plan: 'free', flags: {}, source: 'default' }));
const verifyLicenseMock = vi.fn();
const writeCachedEntitlementMock = vi.fn(() => true);
const writeFounderRecordMock = vi.fn();
let tempDataDir: string | null = null;

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
}));

vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({
  proxyBaseUrl: () => 'https://license.test',
}));

vi.mock('@/lib/entitlement/bootstrap', () => ({
  getOrCreateInstallId: () => 'install_123',
}));

vi.mock('@/lib/entitlement/founder', () => ({
  clearFounderRecord: clearFounderRecordMock,
  writeFounderRecord: writeFounderRecordMock,
}));

vi.mock('@/lib/entitlement/license', () => ({
  clearCachedEntitlement: clearCachedEntitlementMock,
  verifyLicense: verifyLicenseMock,
  writeCachedEntitlement: writeCachedEntitlementMock,
}));

vi.mock('@/lib/entitlement/store', () => ({
  getEntitlement: getEntitlementMock,
}));

function sessionToken(iat: number): string {
  const payload = Buffer.from(JSON.stringify({ iat })).toString('base64url');
  return `header.${payload}.signature`;
}

async function post(body: unknown, token = sessionToken(20)) {
  const { POST } = await import('./route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-session-token': token,
    },
    body: JSON.stringify(body),
  }));
}

describe('entitlement sync route', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-sync-'));
    process.env.CORTEX_IDE_DATA_DIR = tempDataDir;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test';
    authMock.mockResolvedValue({ userId: null, getToken: vi.fn() });
    getEntitlementMock.mockResolvedValue({ plan: 'free', flags: {}, source: 'default' });
    verifyLicenseMock.mockResolvedValue({
      valid: true,
      plan: 'founder',
      expiresAt: 4_102_444_800,
      subject: 'user_founder',
    });
    writeCachedEntitlementMock.mockReturnValue(true);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
      return Response.json({
        license: 'license.jwt',
        source: 'founding',
        founder: { operatorNumber: 2, tier: 1 },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
    tempDataDir = null;
    delete process.env.CORTEX_IDE_DATA_DIR;
  });

  it('clears entitlement and founder state on signed-out sync', async () => {
    const response = await post({ signedOut: true });
    const data = await response.json();

    expect(data.reason).toBe('signed_out');
    expect(clearCachedEntitlementMock).toHaveBeenCalledOnce();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
  });

  it('clears stale paid cache when the active signed-in account has no license', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const response = await post({ clerkUserId: 'user_free' });
    const data = await response.json();

    expect(data.ok).toBe(true);
    expect(data.plan).toBe('free');
    expect(clearCachedEntitlementMock).toHaveBeenCalledOnce();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
  });

  it('refuses to persist a license minted for a previous Clerk identity', async () => {
    const response = await post({ clerkUserId: 'user_free' });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.reason).toBe('license_subject_mismatch');
    expect(clearCachedEntitlementMock).toHaveBeenCalledOnce();
    expect(clearFounderRecordMock).toHaveBeenCalledOnce();
    expect(writeCachedEntitlementMock).not.toHaveBeenCalled();
    expect(writeFounderRecordMock).not.toHaveBeenCalled();
  });
});
