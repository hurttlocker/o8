/**
 * Real-path guard for #1483 — the founder-license auto-wipe on desktop.
 *
 * Reachability rule (repo CLAUDE.md): the guard unit test proves the mechanism
 * in isolation; this drives the ACTUAL GET /api/panel/entitlement route handler
 * with a native-mode-shaped request (Clerk auth() reports no cookie session,
 * exactly like the desktop Tauri webview, where the session lives in the Tauri
 * store) against a persisted founder-shaped entitlement.json — and asserts the
 * license SURVIVES and the plan is reported as 'founder'. The old guard (null
 * activeSubject → drop) wiped both cache files and fell the app back to free.
 *
 * The route resolves its data dir from CORTEX_IDE_DATA_DIR per call, so pointing
 * that at a temp dir with the persisted rows is enough to exercise the real path.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth: authMock }));

let dataDir: string | null = null;

function entitlementPath(): string {
  if (!dataDir) throw new Error('temp data dir not initialized');
  return path.join(dataDir, 'entitlement.json');
}
function founderPath(): string {
  if (!dataDir) throw new Error('temp data dir not initialized');
  return path.join(dataDir, 'founder.json');
}
/** A JWT whose payload subject is an account-bound Clerk id (starts with user_). */
function founderLicenseJwt(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, plan: 'founder' })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('GET /api/panel/entitlement — native-mode founder license survives (real path, #1483)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-native-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_PLAN;
    writeFileSync(
      entitlementPath(),
      `${JSON.stringify({ plan: 'founder', status: 'active', licenseKey: founderLicenseJwt('user_founder') })}\n`,
    );
    writeFileSync(
      founderPath(),
      `${JSON.stringify({ operatorNumber: 7, tier: 1, syncedAt: '2026-07-08T00:00:00.000Z' })}\n`,
    );
  });

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
    delete process.env.CORTEX_IDE_DATA_DIR;
  });

  it('keeps the license and reports the founder plan when auth() has no cookie session', async () => {
    // Native desktop mode: no cookie session reaches server-side auth().
    authMock.mockResolvedValue({ userId: null });

    const { GET } = await import('@/app/api/panel/entitlement/route');
    const res = await GET(new Request('http://localhost/api/panel/entitlement'));
    const data = await res.json();

    expect(data.plan).toBe('founder');
    expect(data.source).toBe('file');
    expect(data.founder?.operatorNumber).toBe(7);
    // The bug wiped both files on read; they MUST survive.
    expect(existsSync(entitlementPath())).toBe(true);
    expect(existsSync(founderPath())).toBe(true);
  });

  it('drops the license when the client forwards a CONFLICTING subject', async () => {
    // Genuine cross-user swap: signed in as a different account than the cached
    // license was minted for → the forwarded ?subject= evidence must drop it.
    authMock.mockResolvedValue({ userId: null });

    const { GET } = await import('@/app/api/panel/entitlement/route');
    const res = await GET(new Request('http://localhost/api/panel/entitlement?subject=user_other'));
    const data = await res.json();

    expect(data.plan).toBe('free');
    expect(existsSync(entitlementPath())).toBe(false);
    expect(existsSync(founderPath())).toBe(false);
  });

  it('keeps the license when the client forwards the MATCHING subject', async () => {
    authMock.mockResolvedValue({ userId: null });

    const { GET } = await import('@/app/api/panel/entitlement/route');
    const res = await GET(new Request('http://localhost/api/panel/entitlement?subject=user_founder'));
    const data = await res.json();

    expect(data.plan).toBe('founder');
    expect(data.founder?.operatorNumber).toBe(7);
    expect(existsSync(entitlementPath())).toBe(true);
  });
});
