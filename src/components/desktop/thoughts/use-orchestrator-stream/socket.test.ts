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
    lastSeqRef,
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

  it('a tool-use event also promotes to busy instead of dropping the pill', () => {
    const h = makeHarness({ status: 'ready' });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash' } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.currentAssistantRef.current).not.toBeNull();
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
