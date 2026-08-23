import { createRequire } from 'node:module';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string, options?: { url?: string }) => {
    window: Window & typeof globalThis;
  };
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3001/dashboard',
});
vi.stubGlobal('window', dom.window);
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
vi.stubGlobal('Element', dom.window.Element);
vi.stubGlobal('Node', dom.window.Node);
vi.stubGlobal('Event', dom.window.Event);
vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const transcriptMock = vi.hoisted(() => ({
  slice: {
    messages: [] as MobileTranscriptEntry[],
    status: 'fresh' as const,
    error: null,
  },
}));

const transcriptRenderMock = vi.hoisted(() => ({
  entries: [] as MobileTranscriptEntry[],
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
vi.mock('./WorkspaceTranscript', () => ({
  WorkspaceTranscript: ({ entries }: { entries: MobileTranscriptEntry[] }) => {
    transcriptRenderMock.entries = entries;
    return createElement('div', null, entries.map((entry) => entry.text).join('\n'));
  },
}));

const { AgentTilePane } = await import('./AgentTilePane');

const originalFetch = globalThis.fetch;
const command = 'grep -n "packet transcript" src/worker.ts';
const toolEvent: TranscriptEvent = {
  seq: 1,
  ts: '2026-08-23T04:00:01.000Z',
  type: 'tool_call',
  tool: 'shell',
  args: JSON.stringify({ command }),
  summary: command,
};
let root: Root;
let host: HTMLDivElement;

function packetFixture(runtime: OrchestratorPacket['runtime'] = 'opencode'): OrchestratorPacket {
  return {
    id: 'packet-worker-pane',
    referenceLabel: 'inline-1',
    title: 'Worker transcript fixture',
    summary: 'Verify the worker transcript pane.',
    workspaceTargetPath: '/tmp/worker-pane',
    branchTarget: 'inline/worker-pane',
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    lane: {
      tileId: 'tile-worker-pane',
      tabId: 'tab-worker-pane',
      repoPath: '/tmp/worker-pane',
      worktreePath: '/tmp/worker-pane',
      runtime,
      sessionKey: 'opencode-owned:worker-pane',
    },
  };
}

async function flushPaneEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPacketPane(
  runtime: OrchestratorPacket['runtime'] = 'opencode',
  transcriptUnsupportedReason?: string,
): Promise<void> {
  await act(async () => {
    root.render(createElement(AgentTilePane, {
      sessionKey: 'opencode-owned:worker-pane',
      agent: { name: 'Worker', status: 'running', runtime, transcriptUnsupportedReason },
      packet: packetFixture(runtime),
      focused: true,
      onClose: () => {},
      onFocus: () => {},
    }));
  });
  await flushPaneEffects();
}

function stubPacketTranscript(events: () => TranscriptEvent[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events: events() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe('AgentTilePane structured packet transcript delivery', () => {
  beforeEach(() => {
    transcriptMock.slice.messages = [
      { id: 'raw-tool', role: 'assistant', text: JSON.stringify({ command }) },
      { id: 'raw-step-finish', role: 'system', text: 'tool-calls' },
    ];
    transcriptRenderMock.entries = [];
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: () => 1,
    });
    Object.defineProperty(dom.window, 'cancelAnimationFrame', {
      configurable: true,
      value: () => {},
    });
    vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  afterAll(() => {
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('refreshes the mounted pane when a later route poll returns another persisted event', async () => {
    vi.useFakeTimers();
    Object.defineProperty(dom.window, 'setInterval', {
      configurable: true,
      value: globalThis.setInterval,
    });
    Object.defineProperty(dom.window, 'clearInterval', {
      configurable: true,
      value: globalThis.clearInterval,
    });
    let events: TranscriptEvent[] = [toolEvent];
    const fetchMock = stubPacketTranscript(() => events);
    await renderPacketPane();

    events = [
      toolEvent,
      {
        seq: 2,
        ts: '2026-08-23T04:00:03.000Z',
        type: 'assistant',
        text: 'Second burst reached the pane.',
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await flushPaneEffects();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transcriptRenderMock.entries.some((entry) => entry.text === 'Second burst reached the pane.')).toBe(true);
  });

  it('renders the structured tool name and readable command instead of serialized arguments', async () => {
    const fetchMock = stubPacketTranscript(() => [toolEvent]);
    await renderPacketPane();

    const toolCall = transcriptRenderMock.entries.flatMap((entry) => entry.toolCalls ?? [])[0];
    expect(fetchMock).toHaveBeenCalled();
    expect(toolCall).toMatchObject({ name: 'shell', args: { command } });
    expect(transcriptRenderMock.entries.some((entry) => entry.text.includes('{"command"'))).toBe(false);
  });

  it('does not render a step_finish reason from the generic history fallback', async () => {
    const fetchMock = stubPacketTranscript(() => [toolEvent]);
    await renderPacketPane();

    expect(fetchMock).toHaveBeenCalled();
    expect(transcriptRenderMock.entries.some((entry) => entry.text.trim() === 'tool-calls')).toBe(false);
  });

  it('uses the structured route for a dispatchable runtime outside the original allowlist', async () => {
    const fetchMock = stubPacketTranscript(() => [toolEvent]);
    await renderPacketPane('grok');

    expect(fetchMock).toHaveBeenCalled();
    expect(transcriptRenderMock.entries.flatMap((entry) => entry.toolCalls ?? [])[0]).toMatchObject({
      name: 'shell',
    });
  });

  it('makes an unsupported structured transcript fallback explicit', async () => {
    const fetchMock = stubPacketTranscript(() => [toolEvent]);
    const unsupportedReason = 'runtime-transcript-not-supported-yet';
    await renderPacketPane('gemini', unsupportedReason);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transcriptRenderMock.entries[0]).toMatchObject({
      role: 'system',
      text: expect.stringContaining(unsupportedReason),
    });
  });
});
