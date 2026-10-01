// @vitest-environment jsdom

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', async () => {
  const { listDispatchableRuntimes } = await import('@/lib/orchestrator/runtime-capabilities');
  return { useRuntimeInventory: () => ({
    inventory: listDispatchableRuntimes().map((id) => ({
      id,
      label: id,
      available: true,
      unavailableReason: null,
      detail: '',
      fix: '',
    })),
    loading: false,
    error: null,
    refresh: () => {},
  }) };
});

const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('./shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('./shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
  ORCHESTRATOR_COMPACTION_STATUS_MIN_MS: 0,
  ORCHESTRATOR_FORCE_COMPACT_THRESHOLD: 10,
  ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS: 0,
  ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS: 0,
}));

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrchestratorStream } from '../useOrchestratorStream';
import type { OrchestratorStreamResult } from './types';

let host: HTMLDivElement;
let root: Root;
let stream: OrchestratorStreamResult;
let releaseReset: () => void = () => {};
let resetStarted: Promise<void>;
let markResetStarted: () => void = () => {};

function Harness({ threadId }: { threadId: string }) {
  const result = useOrchestratorStream('/repo/thread-race', { threadId });
  useEffect(() => { stream = result; }, [result]);
  return createElement('output', null, result.messages.map((message) => message.text).join('|'));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetStarted = new Promise<void>((resolve) => { markResetStarted = resolve; });
  const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/runtime/telemetry')) {
      return new Response(JSON.stringify({ telemetry: { contextTokens: 11 } }), { status: 200 });
    }
    if (url === '/api/orchestrator/compact') {
      return new Response(JSON.stringify({
        ok: true,
        applied: true,
        tokensAfter: 0,
        resumePrelude: 'A_PRELUDE',
        transcript: [{ id: 'a-compacted', role: 'assistant', text: 'A_COMPACTED' }],
      }), { status: 200 });
    }
    if (url === '/api/orchestrator/reset-session') {
      markResetStarted();
      await resetGate;
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
  transport.socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness, { threadId: 'thoughts-a' })));
  await act(async () => transport.socket!.onopen?.(new Event('open')));
  await act(async () => transport.socket!.onmessage?.({
    data: JSON.stringify({
      channel: 'orchestrator',
      event: 'status',
      data: { threadId: 'thoughts-a', backend: 'codex', status: 'ready' },
    }),
  } as MessageEvent));
});

afterEach(async () => {
  releaseReset();
  await act(async () => root.unmount());
  host.remove();
  transport.socket = null;
  vi.unstubAllGlobals();
});

describe('compaction thread binding', () => {
  it('does not apply a compacted transcript or send after the thread changes during reset', async () => {
    await act(async () => { await stream.fetchTelemetrySnapshot(); });
    expect(stream.runningTotal).toBe(11);

    act(() => {
      stream.send('x', { backend: 'codex', model: 'gpt-5.6-sol' });
    });
    await resetStarted;

    await act(async () => {
      root.render(createElement(Harness, { threadId: 'thoughts-b' }));
    });
    act(() => {
      stream.replaceTranscript([{ id: 'b-current', role: 'assistant', text: 'B_CURRENT' }]);
    });
    await act(async () => {
      releaseReset();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(stream.messages.map((message) => message.text)).toEqual(['B_CURRENT']);
    const sent = (transport.socket!.send as ReturnType<typeof vi.fn>).mock.calls
      .map(([payload]) => JSON.parse(payload as string) as { type?: string })
      .filter((payload) => payload.type === 'orchestrator-send');
    expect(sent).toEqual([]);
  });
});
