import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #2486 — the managed judgment allowance and the beta end date through the
 * real operator-defaults route and the TOML file the store writes and reads.
 * Both default to null ("not configured").
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-judgment-allowance-'));
process.env.CORTEX_IDE_DATA_DIR = dir;
process.env.O8_DATA_DIR = dir;

const { POST, GET } = await import('@/app/api/panel/operator-defaults/route');
const { getOperatorDefaults, getOperatorDefaultsTomlPath } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');

function postReq(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getPayload() {
  return (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
}

describe('judgment allowance and beta end date round-trip (#2486)', () => {
  it('defaults both to null from the default source', async () => {
    const payload = await getPayload();
    expect(payload.values.judgmentManagedDailyAllowance).toBeNull();
    expect(payload.values.judgmentBetaEndDate).toBeNull();
    expect(payload.sources.judgmentManagedDailyAllowance).toBe('default');
    expect(payload.sources.judgmentBetaEndDate).toBe('default');
  });

  it('persists both through the real POST, the TOML file, and GET', async () => {
    const res = await POST(postReq({ judgmentManagedDailyAllowance: 40, judgmentBetaEndDate: '2026-12-31' }));
    expect(res.status).toBe(200);
    expect((await res.json()).values).toMatchObject({ judgmentManagedDailyAllowance: 40, judgmentBetaEndDate: '2026-12-31' });

    const toml = readFileSync(getOperatorDefaultsTomlPath(), 'utf8');
    expect(toml).toContain('managed_daily_allowance = 40');
    expect(toml).toContain('beta_end_date = "2026-12-31"');
    expect(parseOperatorDefaultsToml(toml)).toMatchObject({ judgmentManagedDailyAllowance: 40, judgmentBetaEndDate: '2026-12-31' });

    const payload = await getPayload();
    expect(payload.values).toMatchObject({ judgmentManagedDailyAllowance: 40, judgmentBetaEndDate: '2026-12-31' });
    expect(payload.sources.judgmentManagedDailyAllowance).toBe('file');
    expect(payload.sources.judgmentBetaEndDate).toBe('file');
  });

  it('reads hand-edited TOML values', async () => {
    const tomlPath = getOperatorDefaultsTomlPath();
    const toml = readFileSync(tomlPath, 'utf8');
    writeFileSync(tomlPath, toml.replace('managed_daily_allowance = 40', 'managed_daily_allowance = 7').replace('"2026-12-31"', '"2027-01-15"'));
    expect((await getOperatorDefaults()).values).toMatchObject({ judgmentManagedDailyAllowance: 7, judgmentBetaEndDate: '2027-01-15' });
  });

  it('clears both back to null through the route, written as "" in TOML', async () => {
    const res = await POST(postReq({ judgmentManagedDailyAllowance: null, judgmentBetaEndDate: null }));
    expect(res.status).toBe(200);
    const toml = readFileSync(getOperatorDefaultsTomlPath(), 'utf8');
    expect(toml).toContain('managed_daily_allowance = ""');
    expect(toml).toContain('beta_end_date = ""');
    expect(parseOperatorDefaultsToml(toml)).toMatchObject({ judgmentManagedDailyAllowance: null, judgmentBetaEndDate: null });
    expect((await getPayload()).values).toMatchObject({ judgmentManagedDailyAllowance: null, judgmentBetaEndDate: null });
  });

  it('rejects invalid values through the route and the TOML parser', async () => {
    for (const body of [
      { judgmentManagedDailyAllowance: 0 },
      { judgmentManagedDailyAllowance: 2.5 },
      { judgmentManagedDailyAllowance: '40' },
      { judgmentBetaEndDate: '2026-02-30' },
      { judgmentBetaEndDate: '12/31/2026' },
    ]) {
      const res = await POST(postReq(body));
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
    expect(() => parseOperatorDefaultsToml('[judgment]\nmanaged_daily_allowance = -1\n')).toThrow(/integer greater than 0/);
    expect(() => parseOperatorDefaultsToml('[judgment]\nbeta_end_date = "tomorrow"\n')).toThrow(/ISO date/);
  });
});
