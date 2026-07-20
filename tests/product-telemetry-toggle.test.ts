import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-product-telemetry-toggle-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_PROXY_URL = 'https://telemetry.example.test';

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'header.payload.signature' }));

const operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');
const telemetryRoute = await import('@/app/api/panel/telemetry/route');
const { resolveCrashReportsEnabledSync, resolveProductTelemetryEnabledSync } = await import('@/lib/operator/defaults');

function defaultsRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function telemetryRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.sequential('product telemetry persisted consent — real routes', () => {
  it('defaults off for missing or corrupt state and round-trips one server-readable choice', async () => {
    rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
    expect(resolveProductTelemetryEnabledSync()).toBe(false);

    writeFileSync(join(dataDir, 'operator-defaults.json'), '{corrupt');
    expect(resolveProductTelemetryEnabledSync()).toBe(false);

    const enabledResponse = await operatorDefaultsRoute.POST(defaultsRequest({ productTelemetryEnabled: true }));
    const enabledBody = await enabledResponse.json();
    expect(enabledResponse.status).toBe(200);
    expect(enabledBody.values.productTelemetryEnabled).toBe(true);
    expect(enabledBody.sources.productTelemetryEnabled).toBe('file');
    expect(resolveProductTelemetryEnabledSync()).toBe(true);

    const persisted = JSON.parse(readFileSync(join(dataDir, 'operator-defaults.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted.productTelemetryEnabled).toBe(true);
    expect(resolveCrashReportsEnabledSync()).toBe(false);

    const disabledResponse = await operatorDefaultsRoute.POST(defaultsRequest({ productTelemetryEnabled: false }));
    expect((await disabledResponse.json()).values.productTelemetryEnabled).toBe(false);
    expect(resolveProductTelemetryEnabledSync()).toBe(false);
  });

  it('blocks the panel route while off and emits only the allowlisted payload while on', async () => {
    await operatorDefaultsRoute.POST(defaultsRequest({ productTelemetryEnabled: false }));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const offResponse = await telemetryRoute.POST(telemetryRequest({ event: 'app.opened' }));
    expect(await offResponse.json()).toEqual({ ok: true, emitted: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await operatorDefaultsRoute.POST(defaultsRequest({ productTelemetryEnabled: true }));
    const onResponse = await telemetryRoute.POST(telemetryRequest({
      event: 'repo.added',
      props: {
        hasRemote: true,
        isGitRepo: true,
        repoName: 'private-repo',
        path: '/private/path',
        transcript: 'secret',
      },
    }));
    expect(await onResponse.json()).toEqual({ ok: true, emitted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://telemetry.example.test/v1/telemetry');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } }),
    });

    const rejected = await telemetryRoute.POST(telemetryRequest({ event: 'repo.private-path', props: { path: '/secret' } }));
    expect(rejected.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
