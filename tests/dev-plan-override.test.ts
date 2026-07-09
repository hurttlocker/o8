/**
 * "View as Free" dev switch (#1517).
 *
 * Two layers, per the reachability rule (repo CLAUDE.md):
 *   1. UNIT — the pure min-clamp (`clampPlan`) is the security core: an override
 *      may only ever DOWNGRADE.
 *   2. REAL-PATH — drive the ACTUAL GET /api/panel/entitlement + POST/GET
 *      /api/panel/entitlement/override route handlers against persisted rows in a
 *      temp CORTEX_IDE_DATA_DIR (the store resolves its data dir per-call, so
 *      pointing that at a temp dir exercises the real path). Models
 *      tests/entitlement-native-mode.test.ts. Asserts the founder plan reports as
 *      free while the override is set, the license file is NEVER touched, clear
 *      restores founder, and the founder-#1 SET gate + downgrade-only guard hold.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clampPlan } from '@/lib/entitlement/dev-override';

const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth: authMock }));

describe('clampPlan — the min-clamp is downgrade-only (security core)', () => {
  it('free actual + founder override → free (override can NEVER upgrade)', () => {
    expect(clampPlan('free', 'founder')).toBe('free');
  });
  it('founder actual + free override → free (the view-as downgrade)', () => {
    expect(clampPlan('founder', 'free')).toBe('free');
  });
  it('founder actual + no override → founder (unchanged)', () => {
    expect(clampPlan('founder', null)).toBe('founder');
  });
  it('team actual + founder override → team (partial upgrade refused)', () => {
    expect(clampPlan('team', 'founder')).toBe('team');
  });
  it('founder actual + team override → team (partial downgrade honored)', () => {
    expect(clampPlan('founder', 'team')).toBe('team');
  });
  it('pro actual + free override → free', () => {
    expect(clampPlan('pro', 'free')).toBe('free');
  });
});

let dataDir: string | null = null;

function entitlementPath(): string {
  if (!dataDir) throw new Error('temp data dir not initialized');
  return path.join(dataDir, 'entitlement.json');
}
function founderPath(): string {
  if (!dataDir) throw new Error('temp data dir not initialized');
  return path.join(dataDir, 'founder.json');
}
function overridePath(): string {
  if (!dataDir) throw new Error('temp data dir not initialized');
  return path.join(dataDir, 'dev-plan-override');
}
function founderLicenseJwt(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, plan: 'founder' })).toString('base64url');
  return `header.${payload}.signature`;
}
function writeFounderEntitlement() {
  writeFileSync(
    entitlementPath(),
    `${JSON.stringify({ plan: 'founder', status: 'active', licenseKey: founderLicenseJwt('user_founder') })}\n`,
  );
}
function writeFounderRecord(operatorNumber: number) {
  writeFileSync(
    founderPath(),
    `${JSON.stringify({ operatorNumber, tier: 1, syncedAt: '2026-07-08T00:00:00.000Z' })}\n`,
  );
}

describe('View as Free — real path through the entitlement routes (#1517)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-view-as-free-'));
    mkdirSync(dataDir, { recursive: true });
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_PLAN;
    authMock.mockResolvedValue({ userId: null });
  });

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
    delete process.env.CORTEX_IDE_DATA_DIR;
  });

  it('founder #1 can SET the override → GET reports plan=free, and CLEAR restores founder', async () => {
    writeFounderEntitlement();
    writeFounderRecord(1);

    const overrideRoute = await import('@/app/api/panel/entitlement/override/route');
    const entRoute = await import('@/app/api/panel/entitlement/route');

    // Baseline: founder is founder, no override.
    let entRes = await entRoute.GET(new Request('http://localhost/api/panel/entitlement'));
    let ent = await entRes.json();
    expect(ent.plan).toBe('founder');
    expect(ent.actualPlan).toBe('founder');
    expect(ent.overrideActive).toBe(false);
    expect(ent.founder?.operatorNumber).toBe(1);

    // SET view-as-free.
    const setRes = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      }),
    );
    const setData = await setRes.json();
    expect(setData.ok).not.toBe(false);
    expect(setData.active).toBe(true);
    expect(setData.effectivePlan).toBe('free');
    expect(setData.actualPlan).toBe('founder');
    expect(existsSync(overridePath())).toBe(true);

    // The real entitlement now reports the EFFECTIVE (free) view, with founder
    // suppressed — but the license + founder FILES are untouched.
    entRes = await entRoute.GET(new Request('http://localhost/api/panel/entitlement'));
    ent = await entRes.json();
    expect(ent.plan).toBe('free');
    expect(ent.flags['proxy.inference']).toBe(false);
    expect(ent.overrideActive).toBe(true);
    expect(ent.founder).toBeNull();
    expect(ent.actualPlan).toBe('founder');
    expect(ent.actualFounder?.operatorNumber).toBe(1);
    expect(existsSync(entitlementPath())).toBe(true);
    expect(existsSync(founderPath())).toBe(true);

    // CLEAR restores founder.
    const clearRes = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }),
    );
    const clearData = await clearRes.json();
    expect(clearData.active).toBe(false);
    expect(existsSync(overridePath())).toBe(false);

    entRes = await entRoute.GET(new Request('http://localhost/api/panel/entitlement'));
    ent = await entRes.json();
    expect(ent.plan).toBe('founder');
    expect(ent.overrideActive).toBe(false);
    expect(ent.founder?.operatorNumber).toBe(1);
  });

  it('founder #2 is REJECTED from setting an override; founder #1 is accepted', async () => {
    writeFounderEntitlement();
    writeFounderRecord(2);

    const overrideRoute = await import('@/app/api/panel/entitlement/override/route');

    const rejectRes = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      }),
    );
    const rejectData = await rejectRes.json();
    expect(rejectData.ok).toBe(false);
    expect(rejectData.reason).toContain('Founding Operator #1');
    expect(existsSync(overridePath())).toBe(false);

    // Re-point the founder record to #1 → the SAME request now succeeds.
    vi.resetModules();
    writeFounderRecord(1);
    const overrideRoute1 = await import('@/app/api/panel/entitlement/override/route');
    const acceptRes = await overrideRoute1.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      }),
    );
    const acceptData = await acceptRes.json();
    expect(acceptData.ok).not.toBe(false);
    expect(acceptData.active).toBe(true);
    expect(existsSync(overridePath())).toBe(true);
  });

  it('a non-founder (no founder.json) cannot SET, but CLEAR is always allowed', async () => {
    // No founder.json, free entitlement — a plain user.
    const overrideRoute = await import('@/app/api/panel/entitlement/override/route');

    const setRes = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      }),
    );
    expect((await setRes.json()).ok).toBe(false);
    expect(existsSync(overridePath())).toBe(false);

    // Even after a stuck override file lands on disk, CLEAR escapes it.
    writeFileSync(overridePath(), `${JSON.stringify({ plan: 'free', setAt: 'x' })}\n`);
    const clearRes = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }),
    );
    expect((await clearRes.json()).active).toBe(false);
    expect(existsSync(overridePath())).toBe(false);
  });

  it('founder #1 cannot UPGRADE via the override (downgrade-only guard)', async () => {
    // Actual plan is free (no entitlement.json), founder record present as #1.
    writeFounderRecord(1);
    const overrideRoute = await import('@/app/api/panel/entitlement/override/route');

    const res = await overrideRoute.POST(
      new Request('http://localhost/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'founder' }),
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.reason).toContain('downgrade');
    expect(existsSync(overridePath())).toBe(false);
  });
});
