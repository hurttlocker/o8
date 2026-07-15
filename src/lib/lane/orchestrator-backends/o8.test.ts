import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

// The o8 backend streams the desktop free-chat rail (`/api/v2/proxy/llm`). Mock
// the two impure seams it touches — the loopback API base and the thread
// transcript reader — and stub global fetch to feed it fake proxy responses.
// Everything else (SSE parsing, event mapping, ordering) is the backend's own
// logic and is what these tests exercise.
const mockReadMessages = vi.fn();
const mockFetch = vi.fn();
const mockEntitlement = vi.fn();

vi.mock('@/lib/panel/api-port', () => ({
  getApiBase: () => 'http://127.0.0.1:3001',
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  readOrchestratorThreadMessages: (...args: unknown[]) => mockReadMessages(...args),
}));
vi.mock('@/lib/entitlement/store', () => ({
  getEntitlementSync: () => mockEntitlement(),
}));

// Imported after the mocks so the backend binds them.
import { o8Backend, o8TierAccess, o8SystemPrompt } from './o8';

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
  // Default the whole suite to the FREE plan so the tools-off assertions are
  // deterministic on any machine (getEntitlementSync would otherwise read the
  // real founder entitlement on Q's box). Paid-tier tests override per-case.
  mockEntitlement.mockReset().mockReturnValue({ plan: 'free' });
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
    // A scoped repo ('/repo') enables tools for any plan now.
    expect(body.disableTools).toBe(false);
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

describe('o8 backend tool gating (Composer parity) — through the real sendTurn path', () => {
  function bodyOf(): { disableTools: boolean; repoPath?: string; messages: Array<{ role: string; content: string }> } {
    return JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
  }

  it('paid plan + scoped repo → attaches tools, scopes them to the repo, capable + repo-aware prompt', async () => {
    mockEntitlement.mockReturnValue({ plan: 'founder' });
    mockReadMessages.mockReturnValue([{ role: 'user', content: 'build a game' }]);
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'build a game', onEvent, { threadId: 'thoughts-1' });

    const body = bodyOf();
    expect(body.disableTools).toBe(false);
    expect(body.repoPath).toBe('/Users/me/proj');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toMatch(/"proj" repository/);        // repo-aware
    expect(body.messages[0].content).not.toMatch(/conversational only/i);  // capable, not chat-only
  });

  it('FREE plan + scoped repo → ALSO gets tools (Composer parity for free — Q ruling 2026-07-14)', async () => {
    mockEntitlement.mockReturnValue({ plan: 'free' });
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'build a game', onEvent, { threadId: 'thoughts-1' });

    const body = bodyOf();
    expect(body.disableTools).toBe(false);
    expect(body.repoPath).toBe('/Users/me/proj');
    expect(body.messages[0].content).not.toMatch(/conversational only/i);
  });

  it('founders-LOW + scoped repo → still gets tools (rides the free rail, which now runs the loop)', async () => {
    mockEntitlement.mockReturnValue({ plan: 'founder' });
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'q', onEvent, { threadId: 'thoughts-1', thinkingEffort: 'low' });

    const body = bodyOf();
    expect(body.disableTools).toBe(false);
    expect(body.repoPath).toBe('/Users/me/proj');
  });

  it('NO repo scoped → tools OFF for any plan, no repoPath leaks, conversational prompt', async () => {
    mockEntitlement.mockReturnValue({ plan: 'founder' });
    mockFetch.mockResolvedValue(sseResponse([contentFrame('ok'), 'data: [DONE]\n\n']));
    const { onEvent } = collect();

    await o8Backend.sendTurn('', 'just chatting', onEvent, { threadId: 'thoughts-1' });

    const body = bodyOf();
    expect(body.disableTools).toBe(true);
    expect(body.repoPath).toBeUndefined();
    expect(body.messages[0].content).toMatch(/conversational only/i);
  });

  it('maps the tool loop frames to tool_use / tool_result events', async () => {
    mockEntitlement.mockReturnValue({ plan: 'founder' });
    mockFetch.mockResolvedValue(sseResponse([
      `data: ${JSON.stringify({ type: 'tool_use', toolName: 'create_file', toolCallId: 't1', arguments: { file_path: 'x.html' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_result', toolName: 'create_file', toolCallId: 't1', output: 'Created x.html (10 bytes).', status: 'done' })}\n\n`,
      contentFrame('Done.'),
      'data: [DONE]\n\n',
    ]));
    const { events, onEvent } = collect();

    await o8Backend.sendTurn('/Users/me/proj', 'make x.html', onEvent, { threadId: 'thoughts-1' });

    expect(events).toContainEqual({ type: 'tool_use', id: 't1', name: 'create_file', input: { file_path: 'x.html' } });
    expect(events).toContainEqual({ type: 'tool_result', id: 't1', name: 'create_file', output: 'Created x.html (10 bytes).' });
    expect(events.some((e) => e.type === 'text' && e.text === 'Done.')).toBe(true);
  });
});

// 2026-07-15 six-hour-timer incident: the turn's fetch and stream reads were
// unbounded awaits, so a proxy that accepted the request and then went silent
// wedged the turn forever — no error, no done, a busy latch that survived the
// night. These drive the REAL sendTurn against a hung mock and assert the
// inactivity watchdog terminalizes the turn visibly.
describe('o8 backend inactivity watchdog (wedged-turn class)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Mock fetch honoring init.signal the way real fetch does for its body. */
  function hungStreamFetch(framesBeforeHang: string[] = []) {
    const encoder = new TextEncoder();
    mockFetch.mockImplementation((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of framesBeforeHang) controller.enqueue(encoder.encode(frame));
          // …then never enqueue again and never close: the hang.
          init.signal?.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        },
      });
      return Promise.resolve({ ok: true, body } as unknown as Response);
    });
  }

  it('a stream that goes silent forever is terminalized: watchdog error, then done', async () => {
    hungStreamFetch();
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toMatch(/went silent/);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('a fetch that never returns headers is terminalized the same way', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }));
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toMatch(/went silent/);
    expect(events[events.length - 1].type).toBe('done');
  });

  it('received bytes re-arm the watchdog, and streamed text survives the eventual timeout', async () => {
    hungStreamFetch([contentFrame('partial answer')]);
    const { events, onEvent } = collect();

    const turn = o8Backend.sendTurn('/repo', 'hi', onEvent, { threadId: 'thoughts-1' });
    await vi.advanceTimersByTimeAsync(300_000);
    await turn;

    expect(events).toContainEqual({ type: 'text', text: 'partial answer' });
    expect(events.some((e) => e.type === 'error' && (e as { error: string }).error.match(/went silent/))).toBe(true);
    expect(events[events.length - 1].type).toBe('done');
  });
});

// Pure decision matrix — the exact gate sendTurn calls. New invariant: tools gate
// on a scoped repo, NOT the plan — both free and founders edit files when a repo
// is present, and NO repo means no tools for anyone.
describe('o8TierAccess', () => {
  it('free + repo → low tier, tools ON', () => {
    expect(o8TierAccess(false, undefined, true)).toEqual({ tier: 'low', toolsEnabled: true });
  });
  it('free + NO repo → tools OFF', () => {
    expect(o8TierAccess(false, undefined, false)).toEqual({ tier: 'low', toolsEnabled: false });
  });
  it('paid + repo → high tier, tools ON', () => {
    expect(o8TierAccess(true, undefined, true)).toEqual({ tier: 'high', toolsEnabled: true });
  });
  it('paid choosing low + repo → low tier, tools ON (both effort rails edit)', () => {
    expect(o8TierAccess(true, 'low', true)).toEqual({ tier: 'low', toolsEnabled: true });
  });
  it('paid + NO repo → tools OFF', () => {
    expect(o8TierAccess(true, 'high', false)).toEqual({ tier: 'high', toolsEnabled: false });
  });
});

describe('o8SystemPrompt', () => {
  it('tools-on prompt is capable + repo-aware and forbids commit/push/merge', () => {
    const prompt = o8SystemPrompt('high', true, 'my-repo');
    expect(prompt).toMatch(/"my-repo" repository/);
    expect(prompt).toMatch(/never commit, push, or merge/i);
    expect(prompt).not.toMatch(/conversational only/i);
  });
  it('tools-off prompt stays conversational and names no repo/tools', () => {
    const prompt = o8SystemPrompt('low', false, '');
    expect(prompt).toMatch(/conversational only/i);
  });
});
