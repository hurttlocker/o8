import { describe, it, expect, vi } from 'vitest';
import { createOrchestratorMessageHandler, type CurrentAssistantStreamState } from './socket';
import type { OrchestratorStreamStatus } from './shared';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// These tests pin the first-turn streaming race fixed 2026-06-18:
//   1. The server replies with a `status` SNAPSHOT on every (re)subscribe.
//   2. The first orchestrator turn mints a threadId mid-turn, which forces a
//      re-subscribe whose snapshot can arrive as `ready` right after send()
//      optimistically set `busy`.
//   3. Before the fix, that snapshot clobbered the live `busy`, and the output
//      handler then silently dropped every token — the stream was dead until a
//      reload re-loaded the threadId (no mint → no re-subscribe → no clobber).

function makeHarness(initial: {
  status: OrchestratorStreamStatus;
  messages?: MobileTranscriptEntry[];
  current?: CurrentAssistantStreamState | null;
  lastSeq?: number;
}) {
  const ws = {} as WebSocket;
  const statusRef = { current: initial.status };
  const currentAssistantRef = { current: initial.current ?? null };
  const messagesRef = { current: initial.messages ?? [] };
  const lastSeqRef = { current: initial.lastSeq ?? 0 };
  const lastBackendRef = { current: null as string | null };
  const setStatus = vi.fn();
  const setMessages = vi.fn();
  const scheduleFlushCurrentAssistant = vi.fn();
  const flushCurrentAssistant = vi.fn();

  const handler = createOrchestratorMessageHandler({
    captureFirstTurnPlanRef: { current: false },
    currentWs: ws,
    currentAssistantRef,
    eventCountRef: { current: 0 },
    lastSeqRef,
    finalizeFirstTurnPlanCapture: vi.fn(),
    firstTurnPlanChunksRef: { current: [] as string[] },
    firstTurnPlanStartedRef: { current: false },
    flushCurrentAssistant,
    scheduleFlushCurrentAssistant,
    lastBackendRef,
    lastEventAtRef: { current: 0 },
    messagesRef,
    resetEpochRef: { current: 0 },
    setMessages,
    setStatus,
    statusRef,
    wsRef: { current: ws },
  });

  const fire = (payload: Record<string, unknown>) =>
    handler({ data: JSON.stringify(payload) } as MessageEvent);

  return {
    fire,
    statusRef,
    currentAssistantRef,
    messagesRef,
    lastSeqRef,
    lastBackendRef,
    setStatus,
    setMessages,
    scheduleFlushCurrentAssistant,
    flushCurrentAssistant,
  };
}

const userMsg: MobileTranscriptEntry = {
  id: 'orch-user-1',
  role: 'user',
  text: 'hi',
  timestamp: 1,
  timestampLabel: '12:00',
};

describe('orchestrator socket — first-turn streaming race', () => {
  it('a subscribe-ack snapshot "ready" must not clobber an in-flight busy, and the next token still renders', () => {
    // send() just set busy and the user bubble is on screen; then the
    // threadId-mint re-subscribe replies with a stale snapshot:ready.
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('busy'); // NOT downgraded

    // First real token of the turn.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'hello' } });
    expect(h.currentAssistantRef.current).not.toBeNull();
    expect(h.currentAssistantRef.current?.chunks).toContain('hello'); // captured, not dropped
    expect(h.scheduleFlushCurrentAssistant).toHaveBeenCalled();
  });

  it('output implies busy: a token is never dropped even if status was wrongly left at "ready"', () => {
    const h = makeHarness({ status: 'ready' });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'tok' } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.setStatus).toHaveBeenCalledWith('busy');
    expect(h.currentAssistantRef.current?.chunks).toContain('tok');
  });

  it('uses the server-persisted assistant id for streamed bubbles', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'tok', assistantMessageId: 'assistant-123' } });
    expect(h.currentAssistantRef.current?.id).toBe('assistant-123');
  });

  it('a tool-use event also promotes to busy instead of dropping the pill', () => {
    const h = makeHarness({ status: 'ready' });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash' } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.currentAssistantRef.current).not.toBeNull();
  });

  it('keeps messagesRef in lockstep with socket transcript mutations', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash' } });
    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg],
    );

    expect(h.messagesRef.current).toEqual(messages);
    expect(h.messagesRef.current[h.messagesRef.current.length - 1]?.toolCalls?.[0]?.name).toBe('Bash');
  });

  it('a LIVE (non-snapshot) "ready" still finalizes the streamed turn', () => {
    const current: CurrentAssistantStreamState = { id: 'a1', chunks: ['x'], thinkingChunks: [], epoch: 0 };
    const h = makeHarness({ status: 'busy', current });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready' } });
    expect(h.flushCurrentAssistant).toHaveBeenCalled();
    expect(h.currentAssistantRef.current).toBeNull();
    expect(h.statusRef.current).toBe('ready');
  });

  it('a snapshot "busy" resyncs an idle client up to busy (reload into an active turn)', () => {
    const h = makeHarness({ status: 'connecting' });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'busy', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.setStatus).toHaveBeenCalledWith('busy');
  });

  it('a snapshot "ready" settles an idle client (composer stays enabled)', () => {
    const h = makeHarness({ status: 'connecting' });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('ready');
  });

  it('a snapshot "dead" must not clobber a live busy either', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'dead', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
  });
});

describe('orchestrator socket — replay seq cursor', () => {
  it('advances the cursor on a seq-stamped event and renders it', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'a' }, seq: 5 });
    expect(h.lastSeqRef.current).toBe(5);
    expect(h.currentAssistantRef.current?.chunks).toContain('a');
  });

  it('drops a replayed event at or below the cursor (no double-apply), still takes the next', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastSeq: 5 });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'dup' }, seq: 5 });
    expect(h.currentAssistantRef.current).toBeNull(); // dropped — nothing rendered

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'next' }, seq: 6 });
    expect(h.currentAssistantRef.current?.chunks).toContain('next');
    expect(h.lastSeqRef.current).toBe(6);
  });

  it('a snapshot (no seq) is never de-duped and does not move the cursor', () => {
    const h = makeHarness({ status: 'connecting', lastSeq: 9 });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'busy', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.lastSeqRef.current).toBe(9); // unchanged
  });
});

describe('orchestrator socket — cortex_ask tool-result (Brain→Fable transparency card)', () => {
  const askOutput = JSON.stringify({
    ok: true,
    answer: 'The middleware is default-deny.',
    citations: [
      { kind: 'directive', rowId: 'd-12', table: 'directives', title: 'API security gate' },
    ],
    class: 'A',
    retrievalMs: 320,
    classifyMs: 41,
    sourcesConsidered: 18,
    consideredChars: 21400,
    cacheHit: null,
  });

  /** Apply every setMessages updater in call order — the real state the
   *  transcript would hold after the fired events. */
  function reduceMessages(h: ReturnType<typeof makeHarness>, initial: MobileTranscriptEntry[] = []) {
    return h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      initial,
    );
  }

  it('parses the result onto the originating tool call: status done, backend + brainFeed stamped', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({
      channel: 'orchestrator',
      event: 'tool-use',
      data: { name: 'mcp__o8__cortex_ask', args: { question: 'How is the API gated?' }, toolUseId: 'tu-1', backend: 'fable' },
    });
    h.fire({
      channel: 'orchestrator',
      event: 'tool-result',
      data: { name: 'mcp__o8__cortex_ask', toolUseId: 'tu-1', output: askOutput, backend: 'fable' },
    });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe(askOutput);
    expect(tool?.backend).toBe('fable');
    expect(tool?.brainFeed?.question).toBe('How is the API gated?');
    expect(tool?.brainFeed?.citations).toEqual([
      { kind: 'directive', rowId: 'd-12', title: 'API security gate', excerpt: undefined, url: null },
    ]);
    expect(tool?.brainFeed?.sourcesConsidered).toBe(18);
    expect(tool?.brainFeed?.consideredChars).toBe(21400);
  });

  it('falls back to the latest cortex_ask call when the result carries no toolUseId', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'cortex_ask', args: { question: 'q2' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'cortex_ask', output: askOutput, backend: 'fable' } });

    const messages = reduceMessages(h);
    const tools = messages[messages.length - 1]?.toolCalls ?? [];
    expect(tools[0]?.brainFeed).toBeUndefined(); // the Bash call stays untouched
    expect(tools[1]?.brainFeed?.question).toBe('q2');
    expect(tools[1]?.backend).toBe('fable');
  });

  it('ignores non-cortex_ask tool results entirely (no transcript write)', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' }, toolUseId: 'tu-9' } });
    const callsAfterUse = h.setMessages.mock.calls.length;
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-9', output: 'file-a\nfile-b', backend: 'fable' } });
    expect(h.setMessages.mock.calls.length).toBe(callsAfterUse);
  });

  it('an unparseable cortex_ask result still lands result/backend/done — just no brainFeed (card stays a plain chip)', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'cortex_ask', args: { question: 'q' }, toolUseId: 'tu-2' } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'cortex_ask', toolUseId: 'tu-2', output: 'not json at all', backend: 'fable' } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe('not json at all');
    expect(tool?.backend).toBe('fable');
    expect(tool?.brainFeed).toBeUndefined();
  });
});

describe('orchestrator socket — tool error status (turn grammar)', () => {
  function reduceMessages(h: ReturnType<typeof makeHarness>, initial: MobileTranscriptEntry[] = []) {
    return h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      initial,
    );
  }

  it('flips an errored tool call to status "error" and stashes the output', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'npm run build' }, toolUseId: 'tu-1' } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-1', output: 'exit 1: boom', isError: true } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('error');
    expect(tool?.result).toBe('exit 1: boom');
  });

  it('leaves a successful non-cortex tool-result untouched (no transcript write)', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' }, toolUseId: 'tu-2' } });
    const callsAfterUse = h.setMessages.mock.calls.length;
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-2', output: 'ok' } });
    expect(h.setMessages.mock.calls.length).toBe(callsAfterUse);
  });

  it('an errored call falls back to the latest in-flight chip when no toolUseId matches', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Edit', args: { file_path: 'a.ts' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Edit', output: 'patch did not apply', isError: true } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('error');
    expect(tool?.result).toBe('patch did not apply');
  });
});

describe('orchestrator socket — backend tracking (Fable Slice 4)', () => {
  it('resets the replay cursor when a thread switches backend, then applies the new stream', () => {
    const h = makeHarness({ status: 'connecting', lastSeq: 5 });

    // Subscribe-ack snapshot (no seq) — the FIRST thing a fresh client sees.
    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true, backend: 'fable' } });
    expect(h.lastBackendRef.current).toBe('fable');

    // Codex has its own per-session sequence, so seq=1 is new even though the
    // previous Fable session had already reached seq=5.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'codex reply', backend: 'codex' }, seq: 1 });
    expect(h.lastBackendRef.current).toBe('codex');
    expect(h.lastSeqRef.current).toBe(1);
    expect(h.currentAssistantRef.current?.chunks).toContain('codex reply');
  });

  it('leaves lastBackendRef untouched for events without a backend field or off-channel', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'hello' } });
    expect(h.lastBackendRef.current).toBeNull();

    h.fire({ channel: 'supervisor', event: 'agent-update', data: { surfaceId: 's1', backend: 'fable' } });
    expect(h.lastBackendRef.current).toBeNull();
  });
});
