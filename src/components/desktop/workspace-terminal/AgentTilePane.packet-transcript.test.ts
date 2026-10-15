import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PiWorkerSessionRecord } from '@/lib/pi-builtin/types';

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
vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
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

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(),
  requestRealtimeRefresh: vi.fn(),
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/agents/presence?')) {
      return Response.json({ agents: [] });
    }
    return new Response(JSON.stringify({ events: events() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
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

  it('labels a worker with the launched lane model when discovery metadata is stale', async () => {
    stubPacketTranscript(() => []);
    const packet = packetFixture('codex');
    packet.model = 'gpt-5.6-sol';
    packet.lane = { ...packet.lane!, model: 'gpt-5.6-terra' };
    await act(async () => {
      root.render(createElement(AgentTilePane, {
        sessionKey: 'opencode-owned:worker-pane',
        agent: { name: 'Worker', status: 'running', runtime: 'codex', model: 'gpt-6-sol' },
        packet,
        focused: true,
        onClose: () => {},
        onFocus: () => {},
      }));
    });
    expect(host.querySelector('[data-worker-model]')?.textContent).toContain('gpt-5.6-terra');
    expect(host.querySelector('[data-worker-model]')?.getAttribute('title')).toBe('OpenCode 2 · gpt-5.6-terra');
    expect(host.textContent).not.toContain('gpt-6-sol');
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

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/orchestrator/packet-transcript?'))).toHaveLength(2);
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

  it('maps persisted Pi logs through the real route and refreshes after a later persisted event', async () => {
    // WorkspaceTranscript is intentionally mocked above: this proves the mounted
    // pane's polling/mapping boundary, not the visual tool-chip implementation.
    const dataRoot = process.env.CORTEX_IDE_DATA_DIR;
    if (!dataRoot || process.env.O8_DATA_DIR) throw new Error('An isolated test data root is required.');
    const fixtureRoot = mkdtempSync(join(dataRoot, 'pi-pane-transcript-'));
    const priorPiRoot = process.env.O8_OWNED_PI_BUILTIN_ROOT;
    process.env.O8_OWNED_PI_BUILTIN_ROOT = join(fixtureRoot, 'owned-pi-builtin');
    const sessionKey = 'pi-builtin-owned:pane-transcript';
    const sessionDir = join(process.env.O8_OWNED_PI_BUILTIN_ROOT, 'pane-transcript');
    const stdoutPath = join(sessionDir, 'runs', 'run.jsonl');
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });
    const at = '2026-10-14T12:00:00.000Z';
    const logLine = (event: Record<string, unknown>) => `${JSON.stringify({ at, ...event })}\n`;
    writeFileSync(stdoutPath,
      logLine({ type: 'tool_call', name: 'read_file', args: { path: 'src/worker.ts' } })
      + logLine({ type: 'tool_result', name: 'read_file', output: 'Worker source read.', isError: false })
      + logLine({ type: 'assistant', text: 'The worker is ready.' })
      + logLine({ type: 'settled', outcome: 'finished', summary: 'Finished.' }));
    const session: PiWorkerSessionRecord = {
      surfaceId: sessionKey, sessionDir, cwd: fixtureRoot, repoPath: fixtureRoot,
      title: 'Pi pane transcript', createdAt: at, updatedAt: at,
      latestPrompt: 'Read the worker', latestSummary: 'The worker is ready.',
      model: 'fixture-model', readOnly: true,
      recentRuns: [{ id: 'run', mode: 'launch', prompt: 'Read the worker', startedAt: at,
        outcome: 'finished', stdoutPath }],
    };
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(session));

    const received: TranscriptEvent[][] = [];
    let readCompleted!: () => void;
    let readFinished = new Promise<void>((resolve) => { readCompleted = resolve; });
    let getTranscript: typeof import('@/app/api/orchestrator/packet-transcript/route').GET;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(new URL(String(input), dom.window.location.origin), init);
      const url = new URL(request.url);
      if (url.origin !== dom.window.location.origin || request.method !== 'GET') {
        throw new Error(`Unexpected pane fetch: ${request.method} ${url.pathname}`);
      }
      if (url.pathname === '/api/agents/presence') return Response.json({ agents: [] });
      if (url.pathname !== '/api/orchestrator/packet-transcript') {
        throw new Error(`Unexpected pane fetch: ${url.pathname}`);
      }
      const headers = new Headers(request.headers);
      headers.set('host', url.host);
      const response = await getTranscript(new NextRequest(url, { headers, signal: request.signal }));
      expect(response.status).toBe(200);
      received.push((await response.clone().json() as { events: TranscriptEvent[] }).events);
      readCompleted();
      return response;
    });
    const priorWindowFetch = dom.window.fetch;
    globalThis.fetch = fetchMock;
    dom.window.fetch = fetchMock;
    const { closeDb } = await import('@/lib/db');
    try {
      ({ GET: getTranscript } = await import('@/app/api/orchestrator/packet-transcript/route'));
      const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
      const packet = packetFixture('pi-builtin');
      packet.lane = { ...packet.lane!, sessionKey, repoPath: fixtureRoot, worktreePath: fixtureRoot };
      packet.workspaceTargetPath = fixtureRoot;
      writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), packets: [packet] });

      vi.useFakeTimers();
      Object.defineProperty(dom.window, 'setInterval', { configurable: true, value: globalThis.setInterval });
      Object.defineProperty(dom.window, 'clearInterval', { configurable: true, value: globalThis.clearInterval });
      await act(async () => {
        root.render(createElement(AgentTilePane, {
          sessionKey, agent: { name: 'Pi worker', status: 'running', runtime: 'pi-builtin' }, packet,
          focused: true, onClose: () => {}, onFocus: () => {},
        }));
      });
      await act(async () => { await readFinished; });
      expect(received[0].map((event) => event.type)).toEqual(['tool_call', 'tool_result', 'assistant', 'done']);
      expect(transcriptRenderMock.entries).toEqual([expect.objectContaining({
        role: 'assistant', text: 'The worker is ready.',
        toolCalls: [expect.objectContaining({ name: 'read_file', status: 'done',
          args: { path: 'src/worker.ts' }, preview: 'Worker source read.' })],
      })]);
      expect(host.textContent).not.toContain('unavailable');

      appendFileSync(stdoutPath, logLine({ type: 'assistant', text: 'Later Pi event reached the pane.' }));
      readFinished = new Promise<void>((resolve) => { readCompleted = resolve; });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
        await readFinished;
      });
      expect(received).toHaveLength(2);
      expect(received[1].at(-1)).toMatchObject({ seq: 5, type: 'assistant', text: 'Later Pi event reached the pane.' });
      expect(host.textContent).toContain('Later Pi event reached the pane.');
      expect(transcriptRenderMock.entries.some((entry) => entry.text.includes('{"command"'))).toBe(false);
    } finally {
      closeDb();
      dom.window.fetch = priorWindowFetch;
      if (priorPiRoot === undefined) delete process.env.O8_OWNED_PI_BUILTIN_ROOT;
      else process.env.O8_OWNED_PI_BUILTIN_ROOT = priorPiRoot;
    }
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

    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/orchestrator/packet-transcript?'))).toBe(false);
    expect(transcriptRenderMock.entries[0]).toMatchObject({
      role: 'system',
      text: expect.stringContaining(unsupportedReason),
    });
  });
});
