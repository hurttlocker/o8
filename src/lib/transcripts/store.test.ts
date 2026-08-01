import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  MAX_TRANSCRIPT_ENTRIES_PER_SLICE,
  MAX_TRANSCRIPT_STORE_SLICES,
  TranscriptStore,
} from './store';

function entry(index: number): MobileTranscriptEntry {
  return { id: `entry-${index}`, role: 'assistant', text: `message ${index}` };
}

function slice(messages: MobileTranscriptEntry[]) {
  return { messages, status: 'fresh' as const, lastUpdated: Date.now() };
}

describe('TranscriptStore retention', () => {
  it('keeps the newest entries in each slice', () => {
    const store = new TranscriptStore();
    const messages = Array.from({ length: MAX_TRANSCRIPT_ENTRIES_PER_SLICE + 25 }, (_, index) => entry(index));
    store.setSlice('session', slice(messages));

    const retained = store.getSlice('session').messages;
    expect(retained).toHaveLength(MAX_TRANSCRIPT_ENTRIES_PER_SLICE);
    expect(retained[0]?.id).toBe('entry-25');
  });

  it('evicts the oldest unused session slices', () => {
    const store = new TranscriptStore();
    for (let index = 0; index < MAX_TRANSCRIPT_STORE_SLICES + 8; index += 1) {
      store.setSlice(`session-${index}`, slice([entry(index)]));
    }

    expect(store.getSlice('session-0').status).toBe('idle');
    expect(store.getSlice(`session-${MAX_TRANSCRIPT_STORE_SLICES + 7}`).status).toBe('fresh');
  });

  it('does not evict a subscribed transcript', () => {
    const store = new TranscriptStore();
    store.setSlice('watched', slice([entry(0)]));
    const unsubscribe = store.subscribe('watched', () => {});

    for (let index = 0; index < MAX_TRANSCRIPT_STORE_SLICES + 8; index += 1) {
      store.setSlice(`session-${index}`, slice([entry(index)]));
    }

    expect(store.getSlice('watched').status).toBe('fresh');
    unsubscribe();
  });

  it('stays bounded across a long session with repeated transcript discovery', () => {
    const store = new TranscriptStore();
    const messages = Array.from({ length: MAX_TRANSCRIPT_ENTRIES_PER_SLICE + 20 }, (_, index) => entry(index));
    for (let index = 0; index < 500; index += 1) {
      store.setSlice(`session-${index}`, slice(messages));
    }

    let retainedSlices = 0;
    for (let index = 0; index < 500; index += 1) {
      const retained = store.getSlice(`session-${index}`);
      if (retained.status !== 'idle') {
        retainedSlices += 1;
        expect(retained.messages).toHaveLength(MAX_TRANSCRIPT_ENTRIES_PER_SLICE);
      }
    }
    expect(retainedSlices).toBe(MAX_TRANSCRIPT_STORE_SLICES);
    const accessOrder = (store as unknown as { accessOrder: Map<string, number> }).accessOrder;
    expect(accessOrder.size).toBe(MAX_TRANSCRIPT_STORE_SLICES);
  });
});
