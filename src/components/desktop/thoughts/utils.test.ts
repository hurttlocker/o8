import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { mergeSameThreadHistoryLoad } from './utils';

function entry(id: string, role: MobileTranscriptEntry['role'], text: string, timestamp: number): MobileTranscriptEntry {
  return { id, role, text, timestamp, timestampLabel: `${timestamp}` };
}

describe('mergeSameThreadHistoryLoad', () => {
  it('preserves live entries missing from a stale same-thread history fetch', () => {
    const user = entry('u1', 'user', 'review and merge', 1);
    const assistant = entry('a1', 'assistant', 'Packet merged.', 2);

    const result = mergeSameThreadHistoryLoad([user, assistant], [user]);

    expect(result.preservedLiveEntries).toBe(true);
    expect(result.entries.map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('uses the fetched snapshot when it already contains all live entries', () => {
    const user = entry('u1', 'user', 'review and merge', 1);
    const assistant = entry('a1', 'assistant', 'Packet merged from disk.', 2);

    const result = mergeSameThreadHistoryLoad(
      [user, entry('a1', 'assistant', 'Packet merged live.', 2)],
      [user, assistant],
    );

    expect(result.preservedLiveEntries).toBe(false);
    expect(result.entries).toEqual([user, assistant]);
  });

  it('does not turn an empty fetched thread into a destructive clear', () => {
    const user = entry('u1', 'user', 'review and merge', 1);

    const result = mergeSameThreadHistoryLoad([user], []);

    expect(result.preservedLiveEntries).toBe(true);
    expect(result.entries).toEqual([user]);
  });
});
