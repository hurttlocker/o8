import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.fn(async () => ({ userId: null, getToken: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: authMock }));

let dataDir: string;
let originalClerkKey: string | undefined;

function jwt(subject: string, plan: 'free' | 'founder'): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, plan })).toString('base64url');
  return `header.${payload}.signature`;
}

function entitlementPath(): string {
  return path.join(dataDir, 'entitlement.json');
}

async function signOut() {
  const { POST } = await import('@/app/api/panel/entitlement/sync/route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedOut: true }),
  }));
}

async function syncFreeAccount() {
  const { POST } = await import('@/app/api/panel/entitlement/sync/route');
  return POST(new Request('http://localhost/api/panel/entitlement/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-clerk-session-token': jwt('user_free', 'free'),
    },
    body: JSON.stringify({ clerkUserId: 'user_free' }),
  }));
}

describe('signed-out entitlement lifecycle through the sync route', () => {
  beforeEach(() => {
    vi.resetModules();
    originalClerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test';
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-signed-out-entitlement-'));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_PLAN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CORTEX_IDE_DATA_DIR;
    if (originalClerkKey === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalClerkKey;
  });

  it('demotes a paid account to Free and removes account-bound state', async () => {
    writeFileSync(entitlementPath(), JSON.stringify({
      plan: 'founder',
      status: 'active',
      licenseKey: jwt('user_paid', 'founder'),
    }));
    writeFileSync(path.join(dataDir, 'founder.json'), JSON.stringify({
      operatorNumber: 7,
      tier: 1,
      syncedAt: new Date().toISOString(),
    }));

    const response = await signOut();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ reason: 'signed_out', plan: 'free' });
    expect(existsSync(entitlementPath())).toBe(false);
    expect(existsSync(path.join(dataDir, 'founder.json'))).toBe(false);
  });

  it('keeps an install-scoped free allowance and stable install id', async () => {
    const installToken = jwt('install_123', 'free');
    writeFileSync(entitlementPath(), JSON.stringify({
      plan: 'free',
      status: 'active',
      licenseKey: installToken,
    }));
    writeFileSync(path.join(dataDir, 'install-id'), 'install_123\n');

    const response = await signOut();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ reason: 'signed_out', plan: 'free' });
    expect(JSON.parse(readFileSync(entitlementPath(), 'utf8')).licenseKey).toBe(installToken);
    expect(readFileSync(path.join(dataDir, 'install-id'), 'utf8')).toBe('install_123\n');
  });

  it('keeps the install allowance when a signed-in Free account has no paid license', async () => {
    const installToken = jwt('install_123', 'free');
    writeFileSync(entitlementPath(), JSON.stringify({
      plan: 'free',
      status: 'active',
      licenseKey: installToken,
    }));
    writeFileSync(path.join(dataDir, 'install-id'), 'install_123\n');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/account/link-install')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    }));

    const response = await syncFreeAccount();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, plan: 'free', source: 'file' });
    expect(JSON.parse(readFileSync(entitlementPath(), 'utf8')).licenseKey).toBe(installToken);
    expect(readFileSync(path.join(dataDir, 'install-id'), 'utf8')).toBe('install_123\n');
  });
});
