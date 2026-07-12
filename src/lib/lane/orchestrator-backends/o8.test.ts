import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// Mock the two seams the o8 backend depends on: the free gateway stream and the
// thread-transcript reader. Everything else (event mapping, ordering) is the
// backend's own logic and is what these tests exercise.
const mockStream = vi.fn();
const mockMissing = vi.fn();
const mockReadMessages = vi.fn();

vi.mock('@/lib/chat/gateway-client', () => ({
  streamFreeOrchestratorChat: (...args: unknown[]) => mockStream(...args),
  missingChatGatewayEnv: () => mockMissing(),
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorThreadMessages: (...args: unknown[]) => mockReadMessages(...args),
}));

// Imported after the mocks so the backend binds the mocked modules.
import { o8Backend } from './o8';

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

function collect(): { events: OrchestratorEvent[]; onEvent: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

beforeEach(() => {
  mockStream.mockReset();
  mockMissing.mockReset().mockReturnValue([]);
  mockReadMessages.mockReset().mockReturnValue([{ role: 'user', content: 'hi' }]);
});

describe('o8 backend event mapping', () => {
  it('streams each chunk as a text event, then a terminal done', async () => {
    mockStream.mockReturnValue(fromChunks(['Hel', 'lo']));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done', sessionId: expect.any(String), cost: 0 },
    ]);
  });

  it('surfaces a gateway failure as an error line, then done', async () => {
    mockStream.mockReturnValue((async function* () {
      throw new Error('gateway down');
    })());
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toContain('gateway down');
    expect(events[1].type).toBe('done');
  });

  it('emits only done on a user abort (a stop is not an error)', async () => {
    const controller = new AbortController();
    controller.abort();
    mockStream.mockReturnValue((async function* () {
      throw new Error('aborted');
    })());
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1', signal: controller.signal });

    expect(events).toEqual([{ type: 'done', sessionId: expect.any(String), cost: 0 }]);
  });

  it('errors without touching the gateway when env is unconfigured', async () => {
    mockMissing.mockReturnValue(['VERCEL_AI_GATEWAY_API_KEY']);
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(mockStream).not.toHaveBeenCalled();
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toContain('VERCEL_AI_GATEWAY_API_KEY');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('replays the persisted transcript as-is when it ends on the user turn (no doubling)', async () => {
    const transcript = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    mockReadMessages.mockReturnValue(transcript);
    mockStream.mockReturnValue(fromChunks(['ok']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'second-with-session-rules', onEvent, { threadId: 'thoughts-1' });

    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockStream.mock.calls[0][0].messages).toEqual(transcript);
  });

  it('falls back to the raw message param when there is no persisted transcript', async () => {
    mockReadMessages.mockReturnValue([]);
    mockStream.mockReturnValue(fromChunks(['ok']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'lone message', onEvent, { threadId: null });

    expect(mockStream.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'lone message' }]);
  });
});
