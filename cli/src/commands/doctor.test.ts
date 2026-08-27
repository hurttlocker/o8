import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDoctor } from './doctor';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 doctor persistent terminal canary', () => {
  it('surfaces a recorded plain-shell fallback without failing server health', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/panel/status')) {
        return new Response(JSON.stringify({
          product: 'o8',
          terminalPersistence: {
            status: 'degraded',
            reason: 'tmux_unavailable',
            checkedAt: '2026-08-27T12:00:00.000Z',
          },
        }), { status: 200 });
      }
      if (url.includes('/api/setup/detect')) {
        return new Response(JSON.stringify({ tools: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runDoctor({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      terminalPersistence: { status: string; reason: string };
      findings: Array<{ code: string; level: string }>;
    };
    expect(payload.terminalPersistence).toEqual({
      status: 'degraded',
      reason: 'tmux_unavailable',
      checkedAt: '2026-08-27T12:00:00.000Z',
    });
    expect(payload.findings).toContainEqual(expect.objectContaining({
      code: 'persistent_terminal_degraded',
      level: 'warn',
    }));
  });
});
