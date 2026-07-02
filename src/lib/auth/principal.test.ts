import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

// worker-token.ts reads CORTEX_IDE_DATA_DIR at module load — set it first.
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-worker-tok-'));
const WORKER_TOKEN = 'local-worker-token-abcdef0123456789abcdef';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { resolveRequestPrincipal } = await import('./principal');

function req(headers: Record<string, string> = {}, url = 'http://localhost:3001/api/panel/approvals') {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('resolveRequestPrincipal (CRIT-1 governance principal)', () => {
  it('classifies a caller presenting the worker token as a WORKER', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${WORKER_TOKEN}` }))).toBe('worker');
  });

  it('classifies the worker token in the query string as a WORKER (WS/query path)', () => {
    expect(
      resolveRequestPrincipal(req({}, `http://localhost:3001/api/panel/approvals?token=${WORKER_TOKEN}`)),
    ).toBe('worker');
  });

  it('classifies no token (operator webview / loopback) as OPERATOR', () => {
    expect(resolveRequestPrincipal(req())).toBe('operator');
  });

  it('classifies the ws-token (orchestrator MCP, a different value) as OPERATOR, not worker', () => {
    expect(resolveRequestPrincipal(req({ authorization: 'Bearer some-shared-ws-token-value-not-worker' }))).toBe('operator');
  });

  it('rejects a truncated/near-miss of the worker token (constant-time compare, length guard)', () => {
    expect(resolveRequestPrincipal(req({ authorization: `Bearer ${WORKER_TOKEN.slice(0, -1)}` }))).toBe('operator');
  });
});
