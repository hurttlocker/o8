import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * #2484 — the `managed` judgment provider value through the real
 * operator-defaults route and the TOML file the store writes and reads.
 */
const dir = mkdtempSync(join(os.tmpdir(), 'o8-judgment-managed-'));
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

describe('judgment.provider = managed round-trip (#2484)', () => {
  it('persists managed through the real POST, the TOML file, and GET', async () => {
    const res = await POST(postReq({ judgmentProvider: 'managed' }));
    expect(res.status).toBe(200);
    expect((await res.json()).values.judgmentProvider).toBe('managed');

    const toml = readFileSync(getOperatorDefaultsTomlPath(), 'utf8');
    expect(parseOperatorDefaultsToml(toml).judgmentProvider).toBe('managed');

    const getPayload = await (await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'))).json();
    expect(getPayload.values.judgmentProvider).toBe('managed');
    expect(getPayload.sources.judgmentProvider).toBe('file');
  });

  it('reads managed from a hand-written TOML file', async () => {
    const tomlPath = getOperatorDefaultsTomlPath();
    const toml = readFileSync(tomlPath, 'utf8');
    writeFileSync(tomlPath, toml.replace(/provider = "managed"/, 'provider = "typesafe"'));
    expect((await getOperatorDefaults()).values.judgmentProvider).toBe('typesafe');
    writeFileSync(tomlPath, toml);
    expect((await getOperatorDefaults()).values.judgmentProvider).toBe('managed');
  });

  it('rejects an unknown value through the real route', async () => {
    const res = await POST(postReq({ judgmentProvider: 'hosted' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error).toContain('"off", "typesafe", or "managed"');
    expect(() => parseOperatorDefaultsToml('[judgment]\nprovider = "hosted"\n')).toThrow(/"off", "typesafe", or "managed"/);
  });
});
