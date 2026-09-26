// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import * as actionReceipt from '@/lib/orchestrator/action-receipt';

const transcriptMock = vi.hoisted(() => ({
  slice: {
    messages: [] as MobileTranscriptEntry[],
    status: 'fresh' as const,
    error: null,
  },
}));

vi.mock('@/lib/transcripts/useTranscript', () => ({
  useTranscript: () => transcriptMock.slice,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    form: ({ children, ...props }: { children?: ReactNode }) => createElement('form', props, children),
  },
}));

vi.mock('./SessionTransformMenu', () => ({ SessionTransformMenu: () => null }));
vi.mock('./use-packet-transcript-poll', () => ({
  usePacketTranscriptPoll: () => ({ entries: [], activity: null }),
}));
vi.mock('./WorkspaceTranscript', () => ({
  WorkspaceTranscript: ({ entries }: { entries: MobileTranscriptEntry[] }) => createElement(
    'div',
    null,
    entries.map((entry) => entry.text).join(''),
  ),
}));

import {
  AgentTilePane,
  canSteerAgentState,
  classifyAgentTileStatus,
  normalizeAgentTileTranscript,
  resolveAgentTileStatus,
} from './AgentTilePane';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let animationFrames = new Map<number, FrameRequestCallback>();
let nextAnimationFrame = 1;
let resizeCallbacks: ResizeObserverCallback[] = [];

function flushAnimationFrame() {
  const pending = [...animationFrames.values()];
  animationFrames.clear();
  pending.forEach((callback) => callback(performance.now()));
}

beforeEach(() => {
  animationFrames = new Map();
  nextAnimationFrame = 1;
  resizeCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame;
    nextAnimationFrame += 1;
    animationFrames.set(frame, callback);
    return frame;
  });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => {
    animationFrames.delete(frame);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }

    observe() {}
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('normalizeAgentTileTranscript', () => {
  it('shows the assigned task instead of the injected worker envelope', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: [
        '## Project Brief',
        '',
        'Project: Workspace (0 repos)',
        '',
        '## Task',
        'Packet: Verify Codex setup',
        'Summary: Task inline-1: Verify Codex setup',
        '',
        'Add one verification step to README.md.',
        'Branch target: inline/demo',
        'Internal worker rules that should stay hidden.',
      ].join('\n'),
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });

  it('handles the flat prompt shape returned by owned runtime history', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: '## Project Brief Project: Workspace (0 repos) ## Task Packet: Verify Codex setup Summary: Task inline-1: Verify Codex setup Add one verification step to README.md. Branch target: inline/demo Internal worker rules.',
    }], 'Verify Codex setup');

    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });

  it('prepends the operator task when an owned runtime history starts with agent output', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'I will inspect the repository now.',
    }], 'Verify live worker chat', {
      id: 'pkt-live-worker',
      text: 'Read README.md and report its first heading.',
    });

    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'Read README.md and report its first heading.'],
      ['assistant', 'I will inspect the repository now.'],
    ]);
  });

  it('does not duplicate a task already present as the first user turn', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: 'Read README.md.',
    }], 'README check', {
      id: 'pkt-readme',
      text: 'Read README.md.',
    });

    expect(entries).toHaveLength(1);
  });
});

describe('AgentTilePane live transcript scrolling', () => {
  it('follows a growing entry across frames and yields after the operator scrolls up', () => {
    const renderPane = (text: string) => {
      transcriptMock.slice.messages = [{ id: 'assistant-live', role: 'assistant', text }];
      act(() => {
        root?.render(createElement(AgentTilePane, {
          sessionKey: 'codex-owned:live-worker',
          agent: { name: 'Worker', status: 'running', runtime: 'codex' },
          focused: true,
          onClose: () => {},
          onFocus: () => {},
        }));
      });
    };

    renderPane('Starting');
    const scroller = host?.querySelector('.cortex-scroll-fade-y') as HTMLDivElement | null;
    expect(scroller).not.toBeNull();
    if (!scroller) return;

    let scrollHeight = 1_000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 400 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_000);

    scrollHeight = 1_100;
    renderPane('Starting and continuing');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_100);

    scrollHeight = 1_200;
    renderPane('Starting and continuing across another frame');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_200);

    scrollHeight = 1_300;
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    expect(scroller.scrollTop).toBe(1_300);

    act(() => {
      scroller.scrollTop = 600;
      scroller.dispatchEvent(new Event('scroll'));
    });
    scrollHeight = 1_400;
    renderPane('More output that must not yank the operator back down');
    act(flushAnimationFrame);
    act(() => {
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    });
    expect(scroller.scrollTop).toBe(600);

    act(() => {
      scroller.scrollTop = 1_000;
      scroller.dispatchEvent(new Event('scroll'));
    });
    scrollHeight = 1_500;
    renderPane('Pinning resumes after the operator returns to the bottom');
    act(flushAnimationFrame);
    expect(scroller.scrollTop).toBe(1_500);
  });
});

describe('AgentTilePane worker identity', () => {
  it('shows the actual model, current task, and steer recipient in the pane', () => {
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex', model: 'gpt-6-sol', currentTask: 'Trace the handoff' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });

    expect(host?.querySelector('[data-worker-model]')?.textContent).toBe('· gpt-6-sol');
    expect(host?.querySelector('[data-worker-model]')?.parentElement?.parentElement?.textContent).toContain('Worker');
    expect(host?.querySelector('[data-worker-task]')?.textContent).toContain('Trace the handoff');
    expect(host?.textContent).toContain('To @Worker · Steer');
    expect(host?.querySelector('textarea')?.getAttribute('placeholder')).toBe('Message @Worker…');
  });

  it('names the actual operator decision and opens the bound review', () => {
    const openReview = vi.fn();
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:review-worker',
        agent: { name: 'Worker', status: 'idle', runtime: 'codex' },
        packet: {
          id: 'packet-review', status: 'awaiting_review', title: 'Review the change',
          completionSummary: 'The implementation is ready.',
          explainer: { status: 'ready', changedFileCount: 3 },
        } as OrchestratorPacket,
        focused: true,
        onClose: () => {},
        onFocus: () => {},
        onOpenReview: openReview,
      }));
    });

    expect(host?.querySelector('[data-worker-attention]')?.textContent).toContain('Review the finished work');
    expect(host?.querySelector('[data-worker-outcome]')?.textContent).toContain('3 files');
    act(() => host?.querySelector<HTMLButtonElement>('[data-worker-open-review]')?.click());
    expect(openReview).toHaveBeenCalledOnce();
  });

  it('restores the steer text and shows a failed receipt when delivery is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/runtime/action') {
        return new Response(JSON.stringify({ ok: false, error: 'Session unavailable.' }), { status: 409 });
      }
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    }));
    vi.stubGlobal('crypto', { randomUUID: () => 'steer-test-id' });
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:steer-worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });
    const textarea = host?.querySelector('textarea');
    const form = host?.querySelector('form');
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    if (!textarea || !form) return;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(textarea, 'Check the failing test.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(textarea.value).toBe('Check the failing test.');
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Not sent');
    expect(host?.textContent).toContain('Session unavailable.');
  });

  it('checks an uncertain steer using the original mutation body', async () => {
    const receipt = vi.spyOn(actionReceipt, 'fetchCorrelatedActionReceipt')
      .mockRejectedValueOnce(new actionReceipt.CorrelatedActionUnsettledError())
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ ok: true }), { status: 200 }),
        payload: { ok: true },
      });
    const randomUUID = vi.fn(() => 'one-steer-id');
    vi.stubGlobal('crypto', { randomUUID });
    act(() => {
      root?.render(createElement(AgentTilePane, {
        sessionKey: 'codex-owned:steer-worker',
        agent: { name: 'Worker', status: 'running', runtime: 'codex' },
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });
    const textarea = host?.querySelector('textarea');
    const form = host?.querySelector('form');
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    if (!textarea || !form) return;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(textarea, 'Continue the verification.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Receipt unavailable');
    expect(textarea.disabled).toBe(true);
    await act(async () => {
      const check = [...(host?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Check receipt');
      check?.click();
    });
    expect(host?.querySelector('[data-worker-steer-receipt]')?.textContent).toContain('Steer accepted');
    expect(receipt).toHaveBeenCalledTimes(2);
    expect(receipt.mock.calls[0]?.[1]?.body).toBe(receipt.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(receipt.mock.calls[0]?.[1]?.body)).clientMutationId).toBe('one-steer-id');
    expect(randomUUID).toHaveBeenCalledOnce();
  });
});

describe('classifyAgentTileStatus', () => {
  it('shows completed worker output as ready for review', () => {
    expect(classifyAgentTileStatus('awaiting_review')).toBe('review');
  });

  it('keeps a genuine failed transcript red', () => {
    expect(classifyAgentTileStatus('failed')).toBe('error');
  });

  it('shows an idle runtime with a huddle-blocked packet as waiting', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'huddle_ready')).toBe('waiting');
  });

  it('keeps a runtime exit red even when the inventory has already gone idle', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'runtime_process_exit')).toBe('error');
  });
});

describe('canSteerAgentState', () => {
  it('keeps the composer available for a huddle waiting on direction', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'blocked', blockedReason: 'huddle_ready' },
    )).toBe(true);
  });

  it('does not present a steer composer for a failed worker', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'failed', blockedReason: 'runtime_process_exit' },
    )).toBe(false);
  });

  it('offers the composer for an idle packet, which steers successfully (#1846)', () => {
    // The reported pane read `Codex · Codex · Idle` with no composer, while
    // steer_packet against that same packet resumed the worker and produced a
    // new commit. The pane was asserting a false state.
    expect(canSteerAgentState({ status: 'idle' }, { status: 'idle' })).toBe(true);
  });

  it('offers the composer while a packet is recovering between escalation layers', () => {
    expect(canSteerAgentState({ status: 'idle' }, { status: 'recovering' })).toBe(true);
  });

  it('still hides the composer where there is no session to steer', () => {
    expect(canSteerAgentState({ status: 'idle' }, { status: 'draft' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'queued' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'archived' })).toBe(false);
    expect(canSteerAgentState({ status: 'idle' }, { status: 'released' })).toBe(false);
    expect(canSteerAgentState(null, null)).toBe(false);
  });
});
