import { describe, it, expect } from 'vitest';
import { mergeChatMessages } from './merge-chat-messages';

const msg = (
  id: string,
  role: string,
  timestamp: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({ id, role, timestamp, content: `${role}:${id}`, ...extra });

describe('mergeChatMessages (#1282 transcript-loss)', () => {
  it('preserves a stored assistant reply when inbound is the user-only partial (THE bug)', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100)]; // mobile missed the assistant output event
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']); // reply survives
  });

  it('an empty/partial inbound can NEVER wipe the stored transcript', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    expect(mergeChatMessages(existing, []).map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('reinserts a preserved reply chronologically (interleaved partial)', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 150), msg('u2', 'user', 200)];
    const inbound = [msg('u1', 'user', 100), msg('u2', 'user', 200)]; // lost a1 in the middle
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('is the inbound array untouched (fast path) for a full-transcript POST', () => {
    const existing = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100), msg('a1', 'assistant', 101)];
    expect(mergeChatMessages(existing, inbound)).toBe(inbound);
  });

  it('new file (no stored messages): returns inbound', () => {
    const inbound = [msg('u1', 'user', 100)];
    expect(mergeChatMessages([], inbound)).toBe(inbound);
  });

  it('inbound wins for a matching id (update-by-id — e.g. a pin toggle)', () => {
    const existing = [msg('u1', 'user', 100, { pinned: false }), msg('a1', 'assistant', 101)];
    const inbound = [msg('u1', 'user', 100, { pinned: true }), msg('a1', 'assistant', 101)];
    const merged = mergeChatMessages(existing, inbound);
    expect(merged.find((m) => m.id === 'u1')?.pinned).toBe(true);
  });

  it('keeps a stored message that lacks an id (defensive)', () => {
    const existing = [msg('u1', 'user', 100), { role: 'assistant', timestamp: 101, content: 'no-id' }];
    const inbound = [msg('u1', 'user', 100)];
    expect(mergeChatMessages(existing, inbound).length).toBe(2);
  });
});
