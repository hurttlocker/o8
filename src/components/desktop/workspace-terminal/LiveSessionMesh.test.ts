// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcriptStore } from '@/lib/transcripts/store';
import {
  buildLiveSessionMeshParticipants,
  LiveSessionMesh,
  type LiveSessionMeshParticipant,
} from './LiveSessionMesh';

const { bootstrapMock, messageActionMock } = vi.hoisted(() => ({
  bootstrapMock: vi.fn<(sessionKeys: string[], options?: unknown) => Promise<void>>(async () => {}),
  messageActionMock: vi.fn<(action: string) => void>(),
}));

vi.mock('@/lib/transcripts/bootstrap', () => ({
  bootstrapTranscripts: bootstrapMock,
}));

vi.mock('@/components/desktop/DesktopAgentMessage', async () => {
  const React = await import('react');
  return {
    DesktopAgentMessage: ({ entry }: { entry: { id: string; text: string } }) => (
      React.createElement(
        'div',
        { 'data-transcript-entry': entry.id },
        entry.text,
        ...['copy', 'play', 'pin'].map((action) => React.createElement('button', {
          key: action,
          type: 'button',
          'data-message-action': action,
          onClick: () => messageActionMock(action),
        }, action)),
      )
    ),
  };
});

const SESSION_KEYS = Array.from({ length: 8 }, (_, index) => `session:${index + 1}`);

function participant(
  index: number,
  attention: LiveSessionMeshParticipant['attention'] = 'live',
): LiveSessionMeshParticipant {
  return {
    participantId: `participant:${index + 1}`,
    sessionKey: SESSION_KEYS[index] ?? `session:${index + 1}`,
    leafId: `leaf:${index + 1}`,
    arrivalOrder: index,
    name: `Worker ${index + 1}`,
    repo: 'o8',
    runtime: index % 2 === 0 ? 'Codex' : 'Claude Code',
    model: `model-${index + 1}`,
    origin: index % 2 === 0 ? 'Orchestrator' : 'o8 CLI',
    task: `Implement slice ${index + 1}`,
    attention,
    repoPath: '/workspace/o8',
  };
}

function seedTranscripts(): void {
  for (const [index, sessionKey] of SESSION_KEYS.entries()) {
    transcriptStore.setSlice(sessionKey, {
      messages: [{
        id: `message:${index + 1}`,
        role: 'assistant',
        text: `Provider transcript ${index + 1}`,
      }],
      status: 'fresh',
      lastUpdated: index + 1,
    });
  }
}

function MountedHarness({
  initialParticipants,
  initialFocus,
}: {
  initialParticipants: LiveSessionMeshParticipant[];
  initialFocus: string;
}) {
  const [participants, setParticipants] = useState(initialParticipants);
  const [focus, setFocus] = useState(initialFocus);
  return createElement(
    'div',
    { style: { width: 1024, height: 720 } },
    createElement('button', {
      type: 'button',
      'data-rotate-sessions': true,
      onClick: () => setParticipants((current) => current.slice().reverse()),
    }, 'Rotate'),
    createElement('button', {
      type: 'button',
      'data-retire-focused': true,
      onClick: () => setParticipants((current) => current.filter((entry) => entry.sessionKey !== focus)),
    }, 'Retire'),
    createElement(LiveSessionMesh, {
      participants,
      focusedSessionKey: focus,
      onFocusSession: setFocus,
      onCloseSession: () => {},
      renderFocused: (entry) => createElement(
        'div',
        { 'data-mounted-full-transcript': entry.sessionKey },
        entry.name,
      ),
    }),
  );
}

describe('LiveSessionMesh mounted eight-worker harness', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    bootstrapMock.mockClear();
    messageActionMock.mockClear();
    seedTranscripts();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    host.remove();
    for (const sessionKey of SESSION_KEYS) transcriptStore.clear(sessionKey);
  });

  it('mounts one full transcript and seven live transcript tails with one bounded bootstrap and no polling', async () => {
    vi.useFakeTimers();
    const participants = SESSION_KEYS.map((_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[3]!,
      }));
    });

    expect(host.querySelectorAll('[data-mounted-full-transcript]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-live-session-transcript]')).toHaveLength(7);
    expect(host.textContent).toContain('Provider transcript 1');
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    const requestedKeys = bootstrapMock.mock.calls[0]?.[0] as string[];
    expect(new Set(requestedKeys)).toEqual(new Set(SESSION_KEYS.filter((key) => key !== SESSION_KEYS[3])));
    expect(requestedKeys.length).toBeLessThanOrEqual(7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('keeps focus stable across input rotation and switches focus directly from a tail', async () => {
    const participants = SESSION_KEYS.map((_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[3]!,
      }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-rotate-sessions]')?.click();
    });

    expect(host.querySelector('[data-live-session-mesh]')?.getAttribute('data-focused-session')).toBe(SESSION_KEYS[3]);
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-live-session-focus="${SESSION_KEYS[0]}"]`)?.click();
    });
    expect(host.querySelector('[data-live-session-mesh]')?.getAttribute('data-focused-session')).toBe(SESSION_KEYS[0]);
  });

  it('keeps transcript actions outside the focus control and does not focus on copy, play, or pin', async () => {
    const participants = SESSION_KEYS.map((_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[0]!,
      }));
    });

    const tail = host.querySelector<HTMLElement>(`[data-live-session-tail="${SESSION_KEYS[1]}"]`);
    expect(tail?.querySelector('button button')).toBeNull();
    for (const action of ['copy', 'play', 'pin']) {
      await act(async () => {
        tail?.querySelector<HTMLButtonElement>(`[data-message-action="${action}"]`)?.click();
      });
      expect(host.querySelector('[data-live-session-mesh]')?.getAttribute('data-focused-session')).toBe(SESSION_KEYS[0]);
    }
    expect(messageActionMock.mock.calls.map(([action]) => action)).toEqual(['copy', 'play', 'pin']);
  });

  it('retires a terminal participant without deleting its archived transcript slice', async () => {
    const participants = SESSION_KEYS.map((_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[3]!,
      }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-retire-focused]')?.click();
    });

    expect(host.querySelector('[data-live-session-mesh]')?.getAttribute('data-focused-session')).not.toBe(SESSION_KEYS[3]);
    expect(host.querySelector(`[data-live-session-tail="${SESSION_KEYS[3]}"]`)).toBeNull();
    expect(transcriptStore.getSlice(SESSION_KEYS[3]).messages[0]?.text).toBe('Provider transcript 4');
  });

  it('bounds the common-width mesh instead of creating an eight-column overflow', async () => {
    const participants = SESSION_KEYS.map((_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[0]!,
      }));
    });

    const mesh = host.querySelector<HTMLElement>('[data-live-session-mesh]');
    const tailRail = host.querySelector<HTMLElement>('[aria-label="Other live worker transcripts"]');
    expect(mesh?.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
    expect(mesh?.style.gridTemplateColumns).toContain('clamp(184px, 30%, 280px)');
    expect(mesh?.style.overflow).toBe('hidden');
    expect(tailRail?.style.overflowX).toBe('hidden');
    expect(tailRail?.style.overflowY).toBe('auto');
  });

  it('keeps workers beyond eight reachable in one scrollable remainder rail', async () => {
    const participants = Array.from({ length: 12 }, (_, index) => participant(index));
    await act(async () => {
      root.render(createElement(MountedHarness, {
        initialParticipants: participants,
        initialFocus: SESSION_KEYS[0]!,
      }));
    });

    expect(host.querySelector('[data-live-session-remainder="4"]')?.textContent).toContain('12 live workers');
    expect(host.querySelectorAll('[data-live-session-transcript]')).toHaveLength(11);
    expect(host.querySelector('[data-live-session-tail="session:12"]')).not.toBeNull();
  });

  it('uses persisted broker truth when an outside worker has no current mission packet', () => {
    const participants = buildLiveSessionMeshParticipants([{
      type: 'leaf',
      id: 'leaf-external',
      kind: 'session',
      sessionKey: 'opencode-owned:external',
      participantId: 'packet-external',
      packetId: 'packet-external',
      laneId: 'lane-external',
      repoPath: '/repo/external-app',
      runtime: 'codex',
      title: 'Inspect the external repository',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        caller: 'outside terminal',
      },
    }], [{
      sessionKey: 'opencode-owned:external',
      status: 'running',
    }], []);

    expect(participants).toEqual([expect.objectContaining({
      participantId: 'packet-external',
      repo: 'external-app',
      repoPath: '/repo/external-app',
      runtime: 'Codex',
      model: null,
      origin: 'outside terminal via o8 MCP',
      task: 'Inspect the external repository',
    })]);
  });
});
