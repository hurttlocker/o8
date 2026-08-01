import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  MAX_THREAD_HISTORY_WINDOW_ENTRIES,
  prependBoundedThreadHistoryEntries,
} from './thread-history-window';

function entries(start: number, count: number): MobileTranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${start + index}`,
    role: 'assistant',
    text: `message ${start + index}`,
  }));
}

describe('thread history window', () => {
  it('keeps fetched older pages outside the live transcript retention reducer', () => {
    const first = prependBoundedThreadHistoryEntries([], entries(940, 60));
    const second = prependBoundedThreadHistoryEntries(first.entries, entries(880, 60));
    expect(second.entries[0]?.id).toBe('message-880');
    expect(second.entries.at(-1)?.id).toBe('message-999');
  });

  it('stops at a bounded window while retaining the history nearest the live tail', () => {
    let retained: MobileTranscriptEntry[] = [];
    for (let page = 0; page < 10; page += 1) {
      const result = prependBoundedThreadHistoryEntries(retained, entries(940 - page * 60, 60));
      retained = result.entries;
    }

    expect(retained).toHaveLength(MAX_THREAD_HISTORY_WINDOW_ENTRIES);
    expect(retained[0]?.id).toBe('message-800');
    expect(retained.at(-1)?.id).toBe('message-999');
  });

  it('deduplicates overlap between adjacent history pages', () => {
    const current = entries(100, 60);
    const result = prependBoundedThreadHistoryEntries(current, entries(90, 20));
    expect(result.entries.filter((entry) => entry.id === 'message-100')).toHaveLength(1);
  });
});
