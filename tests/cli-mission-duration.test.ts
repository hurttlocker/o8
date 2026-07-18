import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, EXIT } from '../cli/src/api';
import { parseDurationMs } from '../cli/src/commands/mission';
import type { ResolvedConfig } from '../cli/src/config';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mission CLI duration parsing', () => {
  it('keeps bare timeout values in milliseconds', () => {
    expect(parseDurationMs('5400', 60_000)).toBe(5_400);
  });

  it('accepts seconds and minutes suffixes', () => {
    expect(parseDurationMs('90s', 60_000)).toBe(90_000);
    expect(parseDurationMs('5m', 60_000)).toBe(300_000);
  });
});

describe('mission CLI busy errors', () => {
  it('preserves mission_store_busy and exits nonzero with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'mission_store_busy',
        message: 'Mission store is busy dispatching — retry in a moment.',
      },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));
    const config: ResolvedConfig = {
      apiPort: 3001,
      apiBase: 'http://127.0.0.1:3001',
      token: null,
      workerPacketId: null,
      source: { port: 'default', token: 'none' },
      dataDir: null,
    };

    await expect(apiFetch(config, '/api/orchestrator/create-mission', {
      method: 'POST',
      body: {},
    })).rejects.toMatchObject({
      code: 'mission_store_busy',
      message: 'Mission store is busy dispatching — retry in a moment.',
      exit: EXIT.CONFLICT,
    });
  });
});
