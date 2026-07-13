import { describe, it, expect } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { dedupeDisplayMessages, USER_ECHO_DEDUPE_WINDOW_MS } from './dedupe-display-messages';

function entry(partial: Partial<MobileTranscriptEntry> & { id: string; role: MobileTranscriptEntry['role'] }): MobileTranscriptEntry {
  return { text: '', ...partial };
}

const BASE_TS = 1783944779973; // the id timestamp from the live bug report

describe('dedupeDisplayMessages — merged orchestrator transcript', () => {
  it('returns the same reference when there is nothing to collapse', () => {
    const entries = [
      entry({ id: 'orch-user-1', role: 'user', text: 'hi', timestamp: BASE_TS }),
      entry({ id: 'assistant-1', role: 'assistant', text: 'hello', timestamp: BASE_TS + 500 }),
    ];
    expect(dedupeDisplayMessages(entries)).toBe(entries);
  });

  it('collapses an exact-id duplicate, keeping the last (most complete) data', () => {
    const entries = [
      entry({ id: 'orch-user-1', role: 'user', text: 'ship it', timestamp: BASE_TS }),
      entry({ id: 'assistant-1', role: 'assistant', text: 'partial', timestamp: BASE_TS + 500 }),
      // same assistant id re-applied by a stream replay with the final text
      entry({ id: 'assistant-1', role: 'assistant', text: 'final answer', timestamp: BASE_TS + 900 }),
    ];
    const out = dedupeDisplayMessages(entries);
    expect(out.map((m) => m.id)).toEqual(['orch-user-1', 'assistant-1']);
    expect(out.find((m) => m.id === 'assistant-1')?.text).toBe('final answer');
  });

  it('collapses the reload overlap: restored user + differing-id live echo → one bubble', () => {
    // The exact live repro — a mid-conversation reload restores the persisted
    // user bubble (client id from the file) while the live stream still carries
    // an optimistic user bubble with a fresh id for the same message.
    const entries = [
      entry({ id: `orch-user-${BASE_TS}`, role: 'user', text: 'refactor the panel', timestamp: BASE_TS }),
      entry({ id: 'assistant-1', role: 'assistant', text: 'on it', timestamp: BASE_TS + 400 }),
      entry({ id: `orch-user-${BASE_TS + 2000}`, role: 'user', text: 'refactor the panel', timestamp: BASE_TS + 2000 }),
    ];
    const out = dedupeDisplayMessages(entries);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(out.map((m) => m.id)).toEqual([`orch-user-${BASE_TS}`, 'assistant-1']);
  });

  it('ignores surrounding whitespace when matching the echo', () => {
    const entries = [
      entry({ id: 'orch-user-a', role: 'user', text: 'deploy now', timestamp: BASE_TS }),
      entry({ id: 'orch-user-b', role: 'user', text: '  deploy now  ', timestamp: BASE_TS + 1000 }),
    ];
    expect(dedupeDisplayMessages(entries)).toHaveLength(1);
  });

  it('keeps a legitimately repeated user message sent well outside the window', () => {
    const entries = [
      entry({ id: 'orch-user-a', role: 'user', text: 'yes', timestamp: BASE_TS }),
      entry({ id: 'assistant-1', role: 'assistant', text: 'done', timestamp: BASE_TS + 5_000 }),
      // same text, but minutes later — a real second turn, must survive
      entry({ id: 'orch-user-b', role: 'user', text: 'yes', timestamp: BASE_TS + USER_ECHO_DEDUPE_WINDOW_MS + 60_000 }),
    ];
    const out = dedupeDisplayMessages(entries);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('does not collapse identical assistant/system content (only user echoes)', () => {
    const entries = [
      entry({ id: 'assistant-1', role: 'assistant', text: 'ok', timestamp: BASE_TS }),
      entry({ id: 'assistant-2', role: 'assistant', text: 'ok', timestamp: BASE_TS + 1000 }),
      entry({ id: 'sys-1', role: 'system', text: 'note', timestamp: BASE_TS + 1200 }),
      entry({ id: 'sys-2', role: 'system', text: 'note', timestamp: BASE_TS + 1400 }),
    ];
    expect(dedupeDisplayMessages(entries)).toHaveLength(4);
  });

  it('never merges two blank user entries on text alone', () => {
    const entries = [
      entry({ id: 'orch-user-a', role: 'user', text: '', timestamp: BASE_TS }),
      entry({ id: 'orch-user-b', role: 'user', text: '', timestamp: BASE_TS + 1000 }),
    ];
    expect(dedupeDisplayMessages(entries)).toHaveLength(2);
  });
});
