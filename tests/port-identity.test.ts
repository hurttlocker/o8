import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { GET as identityGET } from '@/app/api/setup/identity/route';
import { clearInstanceIdentityCacheForTests, getInstanceIdentity } from '@/lib/panel/instance-identity';
import {
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
  DEV_API_PORT_BLOCK,
  DEV_WS_PORT_BLOCK,
  PROD_API_PORT_BLOCK,
  PROD_WS_PORT_BLOCK,
  RESERVED_PORT_BLOCK,
} from '@/lib/panel/api-port';
import { buildWsHealthPayload } from '@/lib/ws-server/health-payload';
import { decideStalePortRecovery } from '@/lib/ws-server/stale-port-recovery';

const originalEnv = { ...process.env };

function resetEnv(dataDir: string) {
  process.env = { ...originalEnv };
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;
  delete process.env.O8_INSTANCE_ID;
  delete process.env.O8_BOOT_ID;
  delete process.env.O8_API_PORT;
  delete process.env.O8_WS_PORT;
  delete process.env.PORT;
  delete process.env.WS_PORT;
  delete process.env.CORTEX_IDE_PORT;
  delete process.env.O8_DEV_FRONTEND_URL;
  clearInstanceIdentityCacheForTests();
}

describe('port identity', () => {
  beforeEach(() => {
    resetEnv(mkdtempSync(path.join(os.tmpdir(), 'o8-identity-test-')));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    clearInstanceIdentityCacheForTests();
  });

  it('exports the locked port blocks and defaults', () => {
    expect(PROD_API_PORT_BLOCK).toEqual([47100, 47101, 47102, 47103, 47104]);
    expect(PROD_WS_PORT_BLOCK).toEqual([47105, 47106, 47107, 47108, 47109]);
    expect(RESERVED_PORT_BLOCK).toEqual([47110, 47111]);
    expect(DEV_API_PORT_BLOCK).toEqual([47120, 47121, 47122, 47123, 47124]);
    expect(DEV_WS_PORT_BLOCK).toEqual([47125, 47126, 47127, 47128, 47129]);
    expect(DEFAULT_API_PORT).toBe(47100);
    expect(DEFAULT_WS_PORT).toBe(47105);
  });

  it('persists generated instance and boot ids when no sidecar env is present', () => {
    const first = getInstanceIdentity();
    clearInstanceIdentityCacheForTests();
    const second = getInstanceIdentity();

    expect(second.instanceId).toBe(first.instanceId);
    expect(second.bootId).toBe(first.bootId);
    expect(readFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'instance-id'), 'utf-8').trim()).toBe(first.instanceId);
    expect(readFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'boot-id'), 'utf-8').trim()).toBe(first.bootId);
  });

  it('serves /api/setup/identity with the frozen body shape and CORS header', async () => {
    process.env.O8_INSTANCE_ID = 'instance-from-sidecar';
    process.env.O8_BOOT_ID = 'boot-from-sidecar';
    process.env.O8_API_PORT = '47102';
    process.env.O8_WS_PORT = '47107';

    const res = identityGET();
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toMatchObject({
      product: 'o8',
      instanceId: 'instance-from-sidecar',
      bootId: 'boot-from-sidecar',
      apiPort: 47102,
      wsPort: 47107,
    });
    expect(typeof body.version).toBe('string');
  });
});

describe('ws identity health and stale-port recovery', () => {
  it('adds identity fields to the ws health payload', () => {
    expect(buildWsHealthPayload(
      { product: 'o8', instanceId: 'i-1', bootId: 'b-1' },
      { clients: 2, eventLoop: { ok: true } },
    )).toMatchObject({
      product: 'o8',
      instanceId: 'i-1',
      bootId: 'b-1',
      status: 'ok',
      clients: 2,
    });
  });

  it('kills only a stale listener for the same o8 instance', () => {
    expect(decideStalePortRecovery(
      { instanceId: 'same', bootId: 'new' },
      { product: 'o8', instanceId: 'same', bootId: 'old' },
    )).toEqual({ action: 'kill', reason: 'stale-o8-instance' });
  });

  it('does not kill foreign, no-answer, or same-boot listeners', () => {
    const own = { instanceId: 'ours', bootId: 'boot' };
    expect(decideStalePortRecovery(own, { product: 'other', instanceId: 'ours', bootId: 'old' }))
      .toEqual({ action: 'exit', reason: 'foreign-process' });
    expect(decideStalePortRecovery(own, null))
      .toEqual({ action: 'exit', reason: 'no-answer' });
    expect(decideStalePortRecovery(own, { product: 'o8', instanceId: 'ours', bootId: 'boot' }))
      .toEqual({ action: 'exit', reason: 'same-boot' });
  });
});
