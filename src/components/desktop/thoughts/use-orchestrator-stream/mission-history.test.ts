import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { archiveMissionThread } from './mission-history';

const transcript: MobileTranscriptEntry[] = [
  {
    id: 'user-1',
    role: 'user',
    text: 'Build a golden-hour coffee site with a warm editorial feel.',
    timestamp: 1,
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    text: 'I will create the landing page and review the result.',
    timestamp: 2,
  },
];

/**
 * Drives the REAL archive path (`archiveMissionThread` → POST /api/v2/chat-history)
 * and returns the title that actually landed in the request body.
 */
async function archiveAndReadTitle(input: {
  slice: MobileTranscriptEntry[];
  packets: Array<{ id: string; title: string; referenceLabel: string }>;
  missionId: string;
  missionSummary?: string;
}): Promise<string> {
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url.startsWith('/api/v2/chat-history/list')) {
      return new Response(JSON.stringify({ conversations: [] }));
    }
    if (url === '/api/v2/chat-history' && init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', {
    localStorage: { getItem: () => null, setItem: vi.fn() },
    setTimeout: vi.fn(() => 1),
  });

  await archiveMissionThread({
    missionId: input.missionId,
    repoPath: '/repo',
    summary: input.missionSummary ?? 'o8 with 1 task',
    mergedCount: input.packets.length,
    archivedCount: input.packets.length,
    completedAt: '2026-08-23T12:00:00.000Z',
    packets: input.packets,
  }, {
    planText: null,
    replaceTranscript: vi.fn(),
    getTranscript: () => input.slice,
    repoPath: '/repo',
    reset: vi.fn(),
    transcript: input.slice,
    transitionStripTimerRef: { current: null },
  });

  const archiveCall = fetchMock.mock.calls.find(([url, init]) => (
    url === '/api/v2/chat-history' && init?.method === 'POST'
  ));
  vi.unstubAllGlobals();
  return (JSON.parse(String(archiveCall?.[1]?.body)) as { title: string }).title;
}

describe('archiveMissionThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists an intent title instead of the mission stats template', async () => {
    const title = await archiveAndReadTitle({
      slice: transcript,
      packets: [{ id: 'packet-1', title: 'Build coffee site', referenceLabel: 'P1' }],
      missionId: 'mission-title-test',
    });

    expect(title).toBe('Build coffee site');
    expect(title).not.toMatch(/with 1 task|merge|2026-/i);
  });
});

describe('archiveMissionThread — repeated archives from one thread (#1848)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A single long-lived orchestrator thread: every archive slice starts with the
  // same opening operator message, because that message opened the THREAD, not
  // this mission.
  const openingMessage: MobileTranscriptEntry = {
    id: 'user-1',
    role: 'user',
    text: 'Lets keep improving the broadcast surface today.',
    timestamp: 1,
  };

  const firstSlice: MobileTranscriptEntry[] = [
    openingMessage,
    { id: 'assistant-1', role: 'assistant', text: 'On it.', timestamp: 2 },
    { id: 'user-2', role: 'user', text: 'Add a dark mode toggle to the broadcast strip.', timestamp: 3 },
  ];

  const secondSlice: MobileTranscriptEntry[] = [
    openingMessage,
    { id: 'assistant-1', role: 'assistant', text: 'On it.', timestamp: 2 },
    { id: 'user-3', role: 'user', text: 'Now fix the broadcast reconnect storm.', timestamp: 4 },
  ];

  it('names each archive after what that mission did, not the thread opener', async () => {
    const firstTitle = await archiveAndReadTitle({
      slice: firstSlice,
      packets: [{ id: 'p1', title: 'Add broadcast dark mode toggle', referenceLabel: 'P1' }],
      missionId: 'mission-a',
    });
    const secondTitle = await archiveAndReadTitle({
      slice: secondSlice,
      packets: [{ id: 'p2', title: 'Fix broadcast reconnect storm', referenceLabel: 'P2' }],
      missionId: 'mission-b',
    });

    expect(firstTitle).toBe('Add broadcast dark mode toggle');
    expect(secondTitle).toBe('Fix broadcast reconnect storm');
    expect(firstTitle).not.toBe(secondTitle);
  });

  it('falls back to the LAST operator message when a mission merged no packets', async () => {
    const firstTitle = await archiveAndReadTitle({
      slice: firstSlice,
      packets: [],
      missionId: 'mission-c',
    });
    const secondTitle = await archiveAndReadTitle({
      slice: secondSlice,
      packets: [],
      missionId: 'mission-d',
    });

    expect(firstTitle).toBe('Add a dark mode toggle to the broadcast');
    expect(secondTitle).toBe('Now fix the broadcast reconnect storm');
    expect(firstTitle).not.toBe(secondTitle);
  });

  it('skips packets with blank titles and uses the first meaningful one', async () => {
    const title = await archiveAndReadTitle({
      slice: firstSlice,
      packets: [
        { id: 'p1', title: '   ', referenceLabel: 'P1' },
        { id: 'p2', title: 'Add broadcast dark mode toggle', referenceLabel: 'P2' },
      ],
      missionId: 'mission-e',
    });

    expect(title).toBe('Add broadcast dark mode toggle');
  });

  it('prefers the archived slices compaction summary over the last operator message', async () => {
    const compactedSlice: MobileTranscriptEntry[] = [
      openingMessage,
      {
        id: 'compaction-1',
        role: 'system',
        type: 'compaction',
        text: '',
        timestamp: 3,
        compaction: {
          timestamp: 3,
          trigger: 'auto',
          summary: 'Current mission state: hardened the broadcast reconnect path',
        },
      },
      { id: 'user-9', role: 'user', text: 'ok', timestamp: 4 },
    ];

    const title = await archiveAndReadTitle({
      slice: compactedSlice,
      packets: [],
      missionId: 'mission-f',
    });

    expect(title).toBe('hardened the broadcast reconnect path');
  });

  it('falls back to the mission summary when the slice carries no usable seed', async () => {
    const title = await archiveAndReadTitle({
      slice: [{ id: 'user-1', role: 'user', text: '   ', timestamp: 1 }],
      packets: [],
      missionId: 'mission-i',
      missionSummary: 'Sprint mission for broadcast polish',
    });

    expect(title).toBe('broadcast polish');
  });

  it('lets two archives share a title when their outcomes genuinely match', async () => {
    const packets = [{ id: 'p1', title: 'Bump broadcast poll interval', referenceLabel: 'P1' }];
    const first = await archiveAndReadTitle({ slice: firstSlice, packets, missionId: 'mission-g' });
    const second = await archiveAndReadTitle({ slice: secondSlice, packets, missionId: 'mission-h' });

    expect(first).toBe('Bump broadcast poll interval');
    expect(second).toBe(first);
    // No cosmetic disambiguation — no trailing counter, no date stamp.
    expect(first).not.toMatch(/\s\d+$|\d{4}-\d{2}-\d{2}/);
  });
});
