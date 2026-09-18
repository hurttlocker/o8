import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #2485 — the Managed option flag and `judgmentProvider: 'managed'` through
 * the real operator-defaults route and TOML file on a free entitlement, plus
 * the `judgmentPath` the Settings subtitle reads, computed by the route
 * resolver the judgment client calls.
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-judgment-managed-flag-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;
delete process.env.O8_JUDGMENT_API_KEY;

const { POST, GET } = await import('@/app/api/panel/operator-defaults/route');
const { getOperatorDefaultsTomlPath } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { getEntitlementPath } = await import('@/lib/entitlement/store');
const { judgmentKeyPath } = await import('@/lib/judgment/key');

const TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'user_free', plan: 'free' })).toString('base64url')}.signature`;
writeFileSync(getEntitlementPath(), `${JSON.stringify({ plan: 'free', status: 'active', licenseKey: TOKEN })}\n`);

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get() {
  return (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults?include=values'))).json();
}

describe('judgment Managed option flag on a free entitlement (#2485)', () => {
  it('defaults to hidden with the provider off', async () => {
    const payload = await get();
    expect(payload.values.judgmentManagedOptionVisible).toBe(false);
    expect(payload.sources.judgmentManagedOptionVisible).toBe('default');
    expect(payload.values.judgmentProvider).toBe('off');
    expect(payload.judgmentPath).toBe('off');
  });

  it('round-trips managed and the flag through POST, the TOML file, and GET', async () => {
    const res = await POST(postReq({ judgmentProvider: 'managed', judgmentManagedOptionVisible: true }));
    expect(res.status).toBe(200);
    const posted = await res.json();
    expect(posted.values).toMatchObject({ judgmentProvider: 'managed', judgmentManagedOptionVisible: true });
    expect(posted.judgmentPath).toBe('allowance');

    const toml = readFileSync(getOperatorDefaultsTomlPath(), 'utf8');
    expect(toml).toMatch(/managed_option_visible = true/);
    expect(parseOperatorDefaultsToml(toml)).toMatchObject({ judgmentProvider: 'managed', judgmentManagedOptionVisible: true });

    const payload = await get();
    expect(payload.values).toMatchObject({ judgmentProvider: 'managed', judgmentManagedOptionVisible: true });
    expect(payload.sources).toMatchObject({ judgmentProvider: 'file', judgmentManagedOptionVisible: 'file' });
    expect(payload.judgmentPath).toBe('allowance');
  });

  it('keeps a hand-written managed value when the TOML turns the flag off', async () => {
    const tomlPath = getOperatorDefaultsTomlPath();
    writeFileSync(tomlPath, readFileSync(tomlPath, 'utf8').replace('managed_option_visible = true', 'managed_option_visible = false'));
    const payload = await get();
    expect(payload.values).toMatchObject({ judgmentProvider: 'managed', judgmentManagedOptionVisible: false });
    expect(payload.judgmentPath).toBe('allowance');
  });

  it('reports the path the resolver would take for each provider', async () => {
    await POST(postReq({ judgmentProvider: 'typesafe' }));
    expect((await get()).judgmentPath).toBe('none');
    writeFileSync(judgmentKeyPath(), 'ts-key\n', { mode: 0o600 });
    expect((await get()).judgmentPath).toBe('key');
    await POST(postReq({ judgmentProvider: 'off' }));
    expect((await get()).judgmentPath).toBe('off');
  });

  it('rejects a non-boolean flag through the real route and the TOML parser', async () => {
    const res = await POST(postReq({ judgmentManagedOptionVisible: 'yes' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('judgmentManagedOptionVisible must be boolean');
    expect(() => parseOperatorDefaultsToml('[judgment]\nmanaged_option_visible = "yes"\n')).toThrow();
  });
});
