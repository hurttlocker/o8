import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

const binary = vi.hoisted(() => ({
  // A view with surrounding bytes catches accidental use of the backing pool.
  bytes: Buffer.from([99, 0, 255, 128, 13, 10, 42]).subarray(1, 6),
}));
vi.mock('@/lib/tts/edge-neural', () => ({ synthesizeEdgeNeural: async () => binary.bytes }));
vi.mock('@/lib/tts/ensure-edge-tts', () => ({ ensureEdgeTtsInstalled: async () => {} }));
vi.mock('@/lib/push/encrypt', () => ({ encryptPayload: () => binary.bytes }));
vi.mock('@/lib/push/vapid', () => ({
  buildVapidJwt: () => 'fixture', getVapidKeys: () => ({ publicKeyBase64Url: 'fixture' }),
}));
vi.mock('@/lib/push/store', () => ({ recordDeliverySuccess: vi.fn(), recordDeliveryFailure: vi.fn() }));

import { POST as tts } from '@/app/api/tts/route';
import { replayRelayHttpRequest } from '@/lib/mobile/relay-http-replay';
import { RelayHttpRequestRegistry } from '@/lib/mobile/relay-connector-protocol';
import { sendPushToSubscription } from '@/lib/push/send';

afterEach(() => vi.unstubAllGlobals());

it('returns exact MP3 bytes through the TTS route', async () => {
  const response = await tts(new NextRequest('http://localhost/api/tts', {
    method: 'POST', body: JSON.stringify({ text: 'Fixture' }),
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
  expect(response.headers.get('Content-Length')).toBe('5');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(binary.bytes));
});

it('passes a bounded ArrayBuffer-backed encrypted payload to the push transport', async () => {
  const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(Buffer.isBuffer(init?.body)).toBe(false);
    expect(init?.body).toBeInstanceOf(Uint8Array);
    const request = new Request('https://push.example.test/message', init);
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array(binary.bytes));
    return new Response(null, { status: 201 });
  });
  vi.stubGlobal('fetch', transport);
  const result = await sendPushToSubscription({
    endpoint: 'https://push.example.test/message', p256dh: 'fixture', auth: 'fixture',
    userAgent: null, label: null, webhookUrl: null, lastDeliveredAt: null, failureCount: 0,
  }, { title: 'Fixture', body: 'Body' });
  expect(result.ok).toBe(true);
  expect(transport).toHaveBeenCalledOnce();
});

it.each(['POST', 'GET'] as const)('replays %s frames with exact binary bytes or an absent body', async (method) => {
  const transport = vi.fn<typeof fetch>(async (_input, init) => {
    if (method === 'GET') {
      expect(init?.body).toBeUndefined();
    } else {
      expect(Buffer.isBuffer(init?.body)).toBe(false);
      expect(new Uint8Array(await new Request('http://localhost/api/fixture', init).arrayBuffer()))
        .toEqual(new Uint8Array(binary.bytes));
    }
    return new Response('ok');
  });
  const send = vi.fn();
  await replayRelayHttpRequest({
    sid: 'fixture', request: { rid: 'request', method, path: '/api/fixture', bodyB64: binary.bytes.toString('base64') },
    apiBase: 'http://localhost', requestRegistry: new RelayHttpRequestRegistry(),
    timeoutMs: 1000, maxTunnelBytes: 1024, isStreamActive: () => true, send, fetchImpl: transport,
  });
  expect(transport).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 200, bodyB64: Buffer.from('ok').toString('base64') }));
});
