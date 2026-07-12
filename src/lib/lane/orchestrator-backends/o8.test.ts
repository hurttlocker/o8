import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// The o8 backend streams the desktop free-chat rail (`/api/v2/proxy/llm`). Mock
// the two impure seams it touches — the loopback API base and the thread
// transcript reader — and stub global fetch to feed it fake proxy responses.
// Everything else (SSE parsing, event mapping, ordering) is the backend's own
// logic and is what these tests exercise.
const mockReadMessages = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/panel/api-port', () => ({
  getApiBase: () => 'http://127.0.0.1:3001',
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorThreadMessages: (...args: unknown[]) => mockReadMessages(...args),
}));

// Imported after the mocks so the backend binds them.
import { o8Backend } from './o8';

/** A fake SSE proxy response streaming the given `data: …\n\n` frames. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ type: 'content', text })}\n\n`;
}

function collect(): { events: OrchestratorEvent[]; onEvent: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

beforeEach(() => {
  mockReadMessages.mockReset().mockReturnValue([{ role: 'user', content: 'hi' }]);
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('o8 backend event mapping', () => {
  it('maps proxy content frames to text events, then a terminal done', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      contentFrame('Hel'),
      contentFrame('lo'),
      'data: [DONE]\n\n',
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'done', sessionId: expect.any(String), cost: 0 },
    ]);
  });

  it('surfaces an in-stream proxy error frame as an error event, then done', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      contentFrame('partial'),
      `data: ${JSON.stringify({ type: 'error', message: 'model exploded' })}\n\n`,
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(events[0]).toEqual({ type: 'text', text: 'partial' });
    expect(events[1]).toEqual({ type: 'error', error: 'model exploded' });
    expect(events[events.length - 1].type).toBe('done');
  });

  it('emits only done on a user abort (a stop is not an error)', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1', signal: controller.signal });

    expect(events).toEqual([{ type: 'done', sessionId: expect.any(String), cost: 0 }]);
  });

  it('surfaces a non-200 proxy response (JSON error body) as an error line, then done', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
      json: async () => ({ error: 'Gemini quota exhausted and no fallback configured.' }),
    } as unknown as Response);
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toContain('Gemini quota exhausted');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('replays the persisted transcript as-is when it ends on the user turn (no doubling)', async () => {
    const transcript = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    mockReadMessages.mockReturnValue(transcript);
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'second-with-session-rules', onEvent, { threadId: 'thoughts-1' });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      model: string; provider: string; disableTools: boolean; messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('o8-operator');
    expect(body.provider).toBe('operator');
    expect(body.disableTools).toBe(true);
    // System prompt first, then the transcript verbatim (no appended duplicate turn).
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual(transcript);
  });

  it('falls back to the raw message param when there is no persisted transcript', async () => {
    mockReadMessages.mockReturnValue([]);
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/repo', 'lone message', onEvent, { threadId: null });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1)).toEqual([{ role: 'user', content: 'lone message' }]);
  });
});
