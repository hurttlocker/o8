import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let originalDataDir: string | undefined;
let originalPlan: string | undefined;
let originalProxyUrl: string | undefined;

describe('entitlement bootstrap default-free path', () => {
  beforeEach(() => {
    vi.resetModules();
    originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
    originalPlan = process.env.O8_PLAN;
    originalProxyUrl = process.env.O8_PROXY_URL;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-bootstrap-'));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_PLAN;
    delete process.env.O8_PROXY_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
    if (originalPlan === undefined) delete process.env.O8_PLAN;
    else process.env.O8_PLAN = originalPlan;
    if (originalProxyUrl === undefined) delete process.env.O8_PROXY_URL;
    else process.env.O8_PROXY_URL = originalProxyUrl;
  });

  it('resolves the real bootstrap route to free without contacting a license server', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/panel/entitlement/bootstrap/route');
    const response = await POST();
    const state = await response.json();

    expect(response.status).toBe(200);
    expect(state).toMatchObject({
      plan: 'free',
      actualPlan: 'free',
      source: 'default',
      overrideActive: false,
      flags: {
        'proxy.inference': false,
        'relay.offNetwork': false,
        'team.shared': false,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps a configured but unreachable server bounded and avoids retry storms', async () => {
    process.env.O8_PROXY_URL = 'https://license.invalid';
    vi.resetModules();
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/panel/entitlement/bootstrap/route');
    const firstResponse = await POST();
    const secondResponse = await POST();
    const firstState = await firstResponse.json();
    const secondState = await secondResponse.json();

    expect(firstState.plan).toBe('free');
    expect(secondState.plan).toBe('free');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      '[entitlement] License server unavailable; using free plan.',
    );
  });
});
