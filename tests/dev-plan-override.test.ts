import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clampServicePlan } from '@/lib/entitlement/legacy-service-suppression';

const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth: authMock }));

describe('clampServicePlan: the min-clamp is downgrade-only (security core)', () => {
  it('free actual + founder override → free (override can NEVER upgrade)', () => {
    expect(clampServicePlan('free', 'founder')).toBe('free');
  });
  it('founder actual + free override → free (the view-as downgrade)', () => {
    expect(clampServicePlan('founder', 'free')).toBe('free');
  });
  it('founder actual + no override → founder (unchanged)', () => {
    expect(clampServicePlan('founder', null)).toBe('founder');
  });
  it('team actual + founder override → team (partial upgrade refused)', () => {
    expect(clampServicePlan('team', 'founder')).toBe('team');
  });
  it('founder actual + team override → team (partial downgrade honored)', () => {
    expect(clampServicePlan('founder', 'team')).toBe('team');
  });
  it('pro actual + free override → free', () => {
    expect(clampServicePlan('pro', 'free')).toBe('free');
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

describe('legacy funded-service suppression through the entitlement route', () => {
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

  it('keeps an existing suppression from enabling funded services or changing a license', async () => {
    writeFounderEntitlement();
    writeFounderRecord(1);
    writeFileSync(overridePath(), JSON.stringify({ plan: 'free' }));
    const before = readFileSync(entitlementPath(), 'utf8');
    const { GET } = await import('@/app/api/panel/entitlement/route');
    const result = await GET(new Request('http://localhost/api/panel/entitlement'));
    expect(await result.json()).toMatchObject({
      plan: 'free', actualPlan: 'founder', overrideActive: true,
      flags: { 'proxy.inference': false, 'voice.liveBrain': false, 'relay.offNetwork': false, 'cloud.runners': false },
    });
    expect(readFileSync(entitlementPath(), 'utf8')).toBe(before);
  });

  it('retains existing service authorization when no suppression is present', async () => {
    writeFounderEntitlement();
    const { GET } = await import('@/app/api/panel/entitlement/route');
    expect(await (await GET(new Request('http://localhost/api/panel/entitlement'))).json()).toMatchObject({
      plan: 'founder', overrideActive: false,
      flags: { 'proxy.inference': true, 'voice.liveBrain': true, 'relay.offNetwork': true, 'cloud.runners': false },
    });
  });
});
