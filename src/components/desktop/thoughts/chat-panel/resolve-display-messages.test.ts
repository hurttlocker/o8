import { describe, it, expect } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { resolveDisplayMessages } from './resolve-display-messages';

function entry(partial: Partial<MobileTranscriptEntry> & { id: string; role: MobileTranscriptEntry['role'] }): MobileTranscriptEntry {
  return { text: '', ...partial };
}

const BASE_TS = 1787358397405; // the thread id timestamp from the live report

/**
 * The reported thread (`thoughts-1787358397405`) held 25 persisted messages --
 * 21 system dispatch cards, 2 operator questions, 2 assistant answers -- and
 * rendered as one card in whitespace.
 */
function persistedThread(): MobileTranscriptEntry[] {
  const entries: MobileTranscriptEntry[] = [];
  entries.push(entry({ id: 'orch-user-1', role: 'user', text: 'What is o8, in your own words', timestamp: BASE_TS }));
  entries.push(entry({ id: 'assistant-1', role: 'assistant', text: 'o8 is a control plane.', timestamp: BASE_TS + 1_000 }));
  for (let i = 0; i < 21; i += 1) {
    entries.push(entry({ id: `system-${i}`, role: 'system', text: `Mission complete -- packet ${i}`, timestamp: BASE_TS + 2_000 + i }));
  }
  entries.push(entry({ id: 'orch-user-2', role: 'user', text: 'and the governance part?', timestamp: BASE_TS + 30_000 }));
  entries.push(entry({ id: 'assistant-2', role: 'assistant', text: 'Approvals and audit.', timestamp: BASE_TS + 31_000 }));
  return entries;
}

describe('resolveDisplayMessages', () => {
  it('keeps the restored thread when one live event arrives (#1839)', () => {
    const chatMessages = persistedThread();
    // The stream starts empty and fills on the first live event. One dispatch
    // card used to replace the entire restored thread.
    const streamMessages = [
      entry({ id: 'system-live', role: 'system', text: 'Mission complete -- 1 packet merged', timestamp: BASE_TS + 60_000 }),
    ];
    const out = resolveDisplayMessages({ historyEntries: [], chatMessages, streamMessages });

    expect(chatMessages).toHaveLength(25);
    expect(out).toHaveLength(26);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(out.at(-1)?.id).toBe('system-live');
  });

  it('renders the persisted thread while no turn is live', () => {
    const chatMessages = persistedThread();
    const out = resolveDisplayMessages({ historyEntries: [], chatMessages, streamMessages: [] });
    expect(out).toHaveLength(25);
    expect(out).toBe(chatMessages);
  });

  it('does not double-render a turn present in both sources', () => {
    const shared = entry({ id: 'orch-user-9', role: 'user', text: 'ship it', timestamp: BASE_TS });
    const out = resolveDisplayMessages({
      historyEntries: [],
      chatMessages: [shared],
      streamMessages: [
        { ...shared, text: 'ship it' },
        entry({ id: 'assistant-9', role: 'assistant', text: 'done', timestamp: BASE_TS + 500 }),
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['orch-user-9', 'assistant-9']);
  });

  it('orders backfilled history oldest-first, ahead of persisted and live', () => {
    const out = resolveDisplayMessages({
      historyEntries: [entry({ id: 'old-1', role: 'user', text: 'first ever', timestamp: BASE_TS - 100_000 })],
      chatMessages: [entry({ id: 'mid-1', role: 'assistant', text: 'middle', timestamp: BASE_TS })],
      streamMessages: [entry({ id: 'new-1', role: 'system', text: 'newest', timestamp: BASE_TS + 100_000 })],
    });
    expect(out.map((m) => m.id)).toEqual(['old-1', 'mid-1', 'new-1']);
  });

  it('is empty only when every source is empty', () => {
    expect(resolveDisplayMessages({ historyEntries: [], chatMessages: [], streamMessages: [] })).toEqual([]);
  });
});
