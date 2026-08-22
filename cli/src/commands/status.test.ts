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
      return new Response(JSON.stringify({ lanes: [] }), { status: 200 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runStatus({ human: false, verbose: false })).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as {
      counts: { storageHolds: number };
      storageHolds: Array<{ packetId: string; reason: string }>;
    };
    expect(payload.counts.storageHolds).toBe(1);
    expect(payload.storageHolds).toEqual([expect.objectContaining({
      packetId: 'packet-held',
      reason: expect.stringContaining('reserve_breached'),
    })]);
  });
});
