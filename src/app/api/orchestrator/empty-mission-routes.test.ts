import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-empty-mission-routes-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const dispatchRoute = await import('./dispatch/route');
const statusRoute = await import('./status/route');

describe('empty mission operator routes', () => {
  it('rejects async dispatch before claiming that work started', async () => {
    const response = await dispatchRoute.POST(new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', {
      method: 'POST',
      body: JSON.stringify({ wait: false }),
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('returns not_found instead of an empty mission status shape', async () => {
    const response = await statusRoute.GET(new NextRequest('http://127.0.0.1/api/orchestrator/status', {
      headers: { Host: '127.0.0.1' },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});
