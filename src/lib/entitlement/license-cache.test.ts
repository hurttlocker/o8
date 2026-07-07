import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDataDir: string | null = null;

vi.mock('server-only', () => ({}));

function tokenWithSubject(subject: string | null): string {
  const payload = Buffer.from(JSON.stringify(subject ? { sub: subject } : {})).toString('base64url');
  return `header.${payload}.signature`;
}

function entitlementPath(): string {
  if (!tempDataDir) throw new Error('temp data dir not initialized');
  return path.join(tempDataDir, 'entitlement.json');
}

function founderPath(): string {
  if (!tempDataDir) throw new Error('temp data dir not initialized');
  return path.join(tempDataDir, 'founder.json');
}

function writeCache(licenseKey: string): void {
  writeFileSync(entitlementPath(), `${JSON.stringify({ plan: 'founder', status: 'active', licenseKey })}\n`);
  writeFileSync(founderPath(), `${JSON.stringify({ operatorNumber: 1, tier: 1, syncedAt: 'now' })}\n`);
}

describe('cached entitlement read guards', () => {
  beforeEach(() => {
    vi.resetModules();
    tempDataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-license-cache-'));
    process.env.CORTEX_IDE_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    if (tempDataDir) rmSync(tempDataDir, { recursive: true, force: true });
    tempDataDir = null;
    delete process.env.CORTEX_IDE_DATA_DIR;
  });

  it('drops an account-bound cached license when no active subject is present', async () => {
    writeCache(tokenWithSubject('user_founder'));
    const { readCachedEntitlement } = await import('./license');

    expect(readCachedEntitlement()).toBeNull();
    expect(existsSync(entitlementPath())).toBe(false);
    expect(existsSync(founderPath())).toBe(false);
  });

  it('keeps an account-bound cached license for the active subject', async () => {
    writeCache(tokenWithSubject('user_founder'));
    const { readCachedEntitlement } = await import('./license');

    expect(readCachedEntitlement({ activeSubject: 'user_founder' })?.plan).toBe('founder');
    expect(JSON.parse(readFileSync(entitlementPath(), 'utf8'))).toMatchObject({ plan: 'founder' });
    expect(existsSync(founderPath())).toBe(true);
  });

  it('drops an account-bound cached license when the active subject differs', async () => {
    writeCache(tokenWithSubject('user_founder'));
    const { readCachedEntitlement } = await import('./license');

    expect(readCachedEntitlement({ activeSubject: 'user_other' })).toBeNull();
    expect(existsSync(entitlementPath())).toBe(false);
    expect(existsSync(founderPath())).toBe(false);
  });

  it('keeps install-bound cached licenses without an active subject', async () => {
    writeCache(tokenWithSubject('install_123'));
    const { readCachedEntitlement } = await import('./license');

    expect(readCachedEntitlement()?.licenseKey).toBe(tokenWithSubject('install_123'));
    expect(existsSync(entitlementPath())).toBe(true);
    expect(existsSync(founderPath())).toBe(true);
  });
});
