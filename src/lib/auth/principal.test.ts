import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';

// worker-token.ts reads CORTEX_IDE_DATA_DIR at module load — set it first.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-worker-tok-'));
const WORKER_TOKEN = 'local-worker-token-abcdef0123456789abcdef';
const OPERATOR_TOKEN = 'operator-ws-token-abcdef0123456789abcdef';
const DEVICE_TOKEN = 'device-token-abcdef0123456789abcdef';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'mobile-device-tokens'), `${createHash('sha256').update(DEVICE_TOKEN).digest('hex')}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { resolveRequestPrincipal } = await import('./principal');

function req(headers: Record<string, string> = {}, url = 'http://localhost:3001/api/panel/approvals') {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('resolveRequestPrincipal (CRIT-1 governance principal)', () => {
  it('classifies a caller presenting the worker token as a WORKER', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${WORKER_TOKEN}` }))).toBe('worker');
  });

  it('does not accept HTTP query-string credentials', () => {
    expect(
      resolveRequestPrincipal(req({}, `http://localhost:3001/api/panel/approvals?token=${WORKER_TOKEN}`)),
    ).toBe('anonymous');
  });

  it('classifies no token as ANONYMOUS even on loopback', () => {
    expect(resolveRequestPrincipal(req())).toBe('anonymous');
  });

  it('classifies an exact ws-token bearer as OPERATOR', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${OPERATOR_TOKEN}` }))).toBe('operator');
  });

  it('classifies an enrolled per-device bearer as DEVICE', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${DEVICE_TOKEN}` }))).toBe('device');
  });

  it('rejects a truncated/near-miss of the worker token (constant-time compare, length guard)', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${WORKER_TOKEN.slice(0, -1)}` }))).toBe('anonymous');
  });
});
