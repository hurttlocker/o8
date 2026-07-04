import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

process.env.CORTEX_IDE_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR
  ?? mkdtempSync(join(os.tmpdir(), 'o8-pkt-transcript-sk-'));

const route = await import('@/app/api/orchestrator/packet-transcript/route');

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost:3001/api/orchestrator/packet-transcript?${query}`, {
    method: 'GET',
    headers: { host: 'localhost:3001' },
  });
}

describe('packet-transcript route sessionKey fallback (#1389 stale-projection collateral)', () => {
  it('400s when neither packetId nor sessionKey is provided', async () => {
    const res = await route.GET(req('tail=1'));
    expect(res.status).toBe(400);
  });

  it('accepts sessionKey without packetId and returns the events shape', async () => {
    const res = await route.GET(req(`sessionKey=${encodeURIComponent('codex-owned:codex-owned-000-missing')}&tail=1&limit=5`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.events)).toBe(true);
  });
});
