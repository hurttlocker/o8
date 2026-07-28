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

describe('archiveMissionThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists an intent title instead of the mission stats template', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
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
      missionId: 'mission-title-test',
      repoPath: '/repo',
      summary: 'o8 with 1 task',
      mergedCount: 1,
      archivedCount: 1,
      completedAt: '2026-07-28T12:00:00.000Z',
      packets: [{ id: 'packet-1', title: 'Build coffee site', referenceLabel: 'P1' }],
    }, {
      planText: null,
      replaceTranscript: vi.fn(),
      getTranscript: () => transcript,
      repoPath: '/repo',
      reset: vi.fn(),
      transcript,
      transitionStripTimerRef: { current: null },
    });

    const archiveCall = fetchMock.mock.calls.find(([url, init]) => (
      url === '/api/v2/chat-history' && init?.method === 'POST'
    ));
    const body = JSON.parse(String(archiveCall?.[1]?.body)) as { title: string };
    expect(body.title).toBe('Build a golden-hour coffee site with a');
    expect(body.title).not.toMatch(/with 1 task|merge|2026-/i);
  });
});
