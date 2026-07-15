import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { mergeSameThreadHistoryLoad, resolveThreadLoadPlan } from './utils';

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

describe('resolveThreadLoadPlan — RC1 seam 2 (never reset a live in-flight turn)', () => {
  const user = entry('u1', 'user', 'ship it', 1);
  const assistant = entry('a1', 'assistant', 'On it.', 2);

  it('a busy same-thread load is MERGE-ONLY even when the fetch mirrors the live stream (no live-only delta)', () => {
    // This is the exact D7HY6S/J4FHM2 case: mid-turn the incremental server
    // persist already mirrors the live transcript, so mergeSameThreadHistoryLoad
    // reports preservedLiveEntries:false — which USED to trigger reset() and kill
    // the durable turn. The plan must refuse to reset a busy same-thread load.
    const merged = mergeSameThreadHistoryLoad([user, assistant], [user, assistant]);
    expect(merged.preservedLiveEntries).toBe(false);

    const plan = resolveThreadLoadPlan({ isSameOpenThread: true, streamBusy: true, merged });
    expect(plan.reset).toBe(false);
    expect(plan.entries).toEqual(merged.entries);
  });

  it('an idle same-thread load with preserved live entries is also merge-only', () => {
    const merged = mergeSameThreadHistoryLoad([user, assistant], [user]);
    expect(merged.preservedLiveEntries).toBe(true);

    const plan = resolveThreadLoadPlan({ isSameOpenThread: true, streamBusy: false, merged });
    expect(plan.reset).toBe(false);
  });

  it('a genuine thread SWITCH resets (fresh session view)', () => {
    const merged = { entries: [user, assistant], preservedLiveEntries: false };

    const plan = resolveThreadLoadPlan({ isSameOpenThread: false, streamBusy: false, merged });
    expect(plan.reset).toBe(true);
    expect(plan.entries).toEqual([user, assistant]);
  });
});
