import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMsg, runPresence } from './agents';

const originalPort = process.env.O8_API_PORT;
const originalWorkerToken = process.env.O8_WORKER_TOKEN;
const originalWorkerPacketId = process.env.O8_WORKER_PACKET_ID;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPort === undefined) delete process.env.O8_API_PORT;
  else process.env.O8_API_PORT = originalPort;
  if (originalWorkerToken === undefined) delete process.env.O8_WORKER_TOKEN;
  else process.env.O8_WORKER_TOKEN = originalWorkerToken;
  if (originalWorkerPacketId === undefined) delete process.env.O8_WORKER_PACKET_ID;
  else process.env.O8_WORKER_PACKET_ID = originalWorkerPacketId;
});

function workerEnvironment(): void {
  process.env.O8_API_PORT = '40123';
  process.env.O8_WORKER_TOKEN = 'packet-worker-token';
  process.env.O8_WORKER_PACKET_ID = 'packet-conversation';
}

describe('agent conversation CLI', () => {
  it('sends a worker reply with its packet credential without operator presence registration', async () => {
    workerEnvironment();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      message: {
        id: 'message-two', from: 'Aster', to: 'Birch', repo: '/tmp/o8-cli-conversation',
        text: 'Done.', delivery: 'poll', deliveryNote: null, timestamp: '2026-09-23T00:00:00.000Z',
        conversation: { id: 'conversation-one', replyToId: 'message-one', turnIndex: 2, turnLimit: 8, remainingTurns: 6, status: 'closed' },
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMsg({ human: false, verbose: false }, 'send', [
      '--repo', '/tmp/o8-cli-conversation', '--to', 'Birch', '--reply-to', 'message-one', '--close', 'Done.',
    ])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:40123/api/agents/message');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer packet-worker-token' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      repo: '/tmp/o8-cli-conversation', to: 'Birch', replyToId: 'message-one', close: true,
      text: 'Done.', requestId: expect.any(String),
    });
  });

  it('reads worker presence and inbox without trying to join as an operator', async () => {
    workerEnvironment();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/agents/presence')) return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      if (url.includes('/api/agents/inbox')) return new Response(JSON.stringify({
        agent: { name: 'Aster' }, messages: [], cursor: '', hasMore: false,
      }), { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runPresence({ human: false, verbose: false }, 'list', ['--repo', '/tmp/o8-cli-conversation']))
      .resolves.toBe(0);
    await expect(runMsg({ human: false, verbose: false }, 'inbox', ['--repo', '/tmp/o8-cli-conversation']))
      .resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });

  it('quotes a custom sender name in the suggested reply command', async () => {
    workerEnvironment();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      agent: { name: 'Birch' },
      messages: [{
        id: 'message-one', from: "Peer's Runner", to: 'Birch', repo: '/tmp/o8-cli-conversation',
        text: 'Can you check this?', delivery: 'poll', deliveryNote: null,
        timestamp: '2026-09-23T00:00:00.000Z',
        conversation: { id: 'conversation-one', replyToId: null, turnIndex: 1, turnLimit: 8, remainingTurns: 7, status: 'open' },
      }],
      cursor: '1', hasMore: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runMsg({ human: true, verbose: false }, 'inbox', ['--repo', '/tmp/o8-cli-conversation']))
      .resolves.toBe(0);
    expect(write.mock.calls.map(([value]) => String(value)).join(''))
      .toContain("--to 'Peer'\"'\"'s Runner' --reply-to 'message-one'");
  });
});
