// @vitest-environment jsdom

import { act, createElement, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORCHESTRATOR_AUTO_COMPACT_THRESHOLD, type CompactResponsePayload } from './shared';
import { useOrchestratorAutoCompaction } from './auto-compaction';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('thread-bound auto compaction', () => {
  it('discards a deferred result after the active thread changes', async () => {
    let resolveCompaction: (payload: CompactResponsePayload) => void = () => {};
    const deferred = new Promise<CompactResponsePayload>((resolve) => { resolveCompaction = resolve; });
    const requestCompaction = vi.fn(() => deferred);
    const primeCompactedSession = vi.fn(async () => ({}));

    function Harness({ threadId }: { threadId: string }) {
      const threadIdRef = useRef<string | null>(threadId);
      const statusRef = useRef<'ready'>('ready');
      const lastBackendRef = useRef<string | null>('claude');
      const inFlightRef = useRef(false);
      const armedRef = useRef(true);
      useEffect(() => {
        threadIdRef.current = threadId;
      }, [threadId]);
      useOrchestratorAutoCompaction({
        repoPath: '/repo',
        threadId,
        runningTotal: ORCHESTRATOR_AUTO_COMPACT_THRESHOLD,
        status: 'ready',
        lastBackendRef,
        threadIdRef,
        statusRef,
        inFlightRef,
        armedRef,
        requestCompaction,
        primeCompactedSession,
      });
      return null;
    }

    await act(async () => root.render(createElement(Harness, { threadId: 'thoughts-old' })));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(requestCompaction).toHaveBeenCalledWith('/repo', ORCHESTRATOR_AUTO_COMPACT_THRESHOLD, {
      threadId: 'thoughts-old',
    });

    await act(async () => root.render(createElement(Harness, { threadId: 'thoughts-new' })));
    await act(async () => {
      resolveCompaction({ ok: true, applied: true, transcript: [] });
      await deferred;
    });

    expect(primeCompactedSession).not.toHaveBeenCalled();
  });
});
