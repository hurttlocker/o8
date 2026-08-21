import { afterEach, describe, expect, it, vi } from 'vitest';

import { runBroadcast } from './broadcast';

const originalPort = process.env.O8_API_PORT;
const originalToken = process.env.O8_API_TOKEN;
const originalWorkerToken = process.env.O8_WORKER_TOKEN;
const originalWorkerPacketId = process.env.O8_WORKER_PACKET_ID;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPort === undefined) delete process.env.O8_API_PORT;
  else process.env.O8_API_PORT = originalPort;
  if (originalToken === undefined) delete process.env.O8_API_TOKEN;
  else process.env.O8_API_TOKEN = originalToken;
  if (originalWorkerToken === undefined) delete process.env.O8_WORKER_TOKEN;
  else process.env.O8_WORKER_TOKEN = originalWorkerToken;
  if (originalWorkerPacketId === undefined) delete process.env.O8_WORKER_PACKET_ID;
  else process.env.O8_WORKER_PACKET_ID = originalWorkerPacketId;
});

describe('Broadcast CLI token commands', () => {
  it('mints through the real API client and emits a fragment-only spectator URL', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    delete process.env.O8_WORKER_PACKET_ID;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.token.mint/v1',
      ok: true,
      token: { id: 'spectator-one', label: 'OBS', createdAt: '2026-08-21T00:00:00.000Z', revokedAt: null },
      bearer: 'o8sp_secret',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast({ human: false, verbose: false }, 'token', ['mint', '--label', 'OBS']))
      .resolves.toBe(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:40123/api/broadcast/tokens');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer operator-token' });
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'mint', label: 'OBS' });
    const output = write.mock.calls.map(([value]) => String(value)).join('');
    expect(output).toContain('http://127.0.0.1:40123/broadcast#token=o8sp_secret');
    expect(output).not.toContain('/broadcast?token=');
  });

  it('revokes exactly one durable token id', async () => {
    process.env.O8_API_PORT = '40123';
    process.env.O8_API_TOKEN = 'operator-token';
    delete process.env.O8_WORKER_TOKEN;
    delete process.env.O8_WORKER_PACKET_ID;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema: 'o8/broadcast.token.revoke/v1',
      ok: true,
      token: { id: 'spectator-one', label: null, createdAt: '2026-08-21T00:00:00.000Z', revokedAt: '2026-08-21T00:01:00.000Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBroadcast({ human: false, verbose: false }, 'token', ['revoke', 'spectator-one']))
      .resolves.toBe(0);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'revoke', id: 'spectator-one' });
  });
});
