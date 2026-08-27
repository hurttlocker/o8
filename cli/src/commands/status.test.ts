import { afterEach, describe, expect, it, vi } from 'vitest';

import { runStatus } from './status';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 status storage holds', () => {
  it('includes a packet storage hold and its operator-visible reason', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) {
        return new Response(JSON.stringify({ approvals: [] }), { status: 200 });
      }
      if (url.includes('/api/orchestrator/status')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            packets: [{
              id: 'packet-held',
              title: 'held packet',
              status: 'queued',
              blockedReason: 'Dispatch held by storage admission (reserve_breached).',
              storageAdmission: {
                state: 'held',
                reason: 'reserve_breached',
                recordedAt: 1_000,
                estimateBytes: 8_589_934_592,
                physicalAvailableBytes: 12_884_901_888,
                requiredReserveBytes: 10_737_418_240,
              },
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('/api/panel/status')) {
        return new Response(JSON.stringify({
          shippedDarkAudit: {
            status: 'attention',
            checkedAt: '2026-08-27T12:05:00.000Z',
            currentRelease: '0.1.716',
            thresholdReleases: 3,
            checkedFlagCount: 14,
            flags: [{
              tomlKey: 'experimental.chat_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
            }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ lanes: [] }), { status: 200 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      counts: { shippedDarkWarnings: number; storageHolds: number };
      shippedDarkWarnings: Array<{ tomlKey: string; darkForReleases: number }>;
      storageHolds: Array<{ packetId: string; reason: string }>;
    };
    expect(payload.counts.storageHolds).toBe(1);
    expect(payload.storageHolds).toEqual([expect.objectContaining({
      packetId: 'packet-held',
      reason: expect.stringContaining('reserve_breached'),
    })]);
    expect(payload.counts.shippedDarkWarnings).toBe(1);
    expect(payload.shippedDarkWarnings).toEqual([{
      tomlKey: 'experimental.chat_enabled',
      landedRelease: '0.1.681',
      darkForReleases: 35,
    }]);
  });

  it('prints a human warning only after the dark-release threshold', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/panel/approvals')) {
        return Response.json({ approvals: [] });
      }
      if (url.includes('/api/orchestrator/status')) {
        return Response.json({ ok: true, result: { packets: [] } });
      }
      if (url.includes('/api/panel/status')) {
        return Response.json({
          shippedDarkAudit: {
            status: 'attention',
            checkedAt: '2026-08-27T12:05:00.000Z',
            currentRelease: '0.1.716',
            thresholdReleases: 3,
            checkedFlagCount: 14,
            flags: [{
              tomlKey: 'experimental.chat_enabled',
              landedRelease: '0.1.681',
              darkForReleases: 35,
            }, {
              tomlKey: 'broadcast.voice',
              landedRelease: '0.1.715',
              darkForReleases: 1,
            }],
          },
        });
      }
      return Response.json({ lanes: [] });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: true, verbose: false })).resolves.toBe(0);
    const output = writes.join('');
    expect(output).toContain('shipped but dark');
    expect(output).toContain('experimental.chat_enabled');
    expect(output).toContain('35 releases');
    expect(output).not.toContain('broadcast.voice');
  });
});
