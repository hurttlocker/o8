import { describe, expect, it } from 'vitest';
import { RealtimeReplayLog } from '@/lib/realtime/replay-log';
import type { RealtimeEventEnvelope } from '@/lib/realtime/types';

function envelope(seq: number, note = '', stream: 'global' | `session:${string}` = 'global'): RealtimeEventEnvelope {
  return {
    protocol: 1, seq, stream, channel: 'mutation', event: 'mutation.record',
    ts: '2026-01-01T00:00:00.000Z',
    data: { mutation: { mutationId: String(seq), source: 'server', action: 'fixture', status: 'pending', note, createdAt: '' } },
  };
}

const all = () => true;
const bytes = (value: RealtimeEventEnvelope) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('RealtimeReplayLog', () => {
  it('preserves complete Unicode envelopes across repeated storage wraps', () => {
    const limit = 1200;
    const log = new RealtimeReplayLog(4, limit);
    const recorded: RealtimeEventEnvelope[] = [];
    for (let seq = 1; seq <= 40; seq += 1) {
      recorded.push(envelope(seq, '\u{1F9EA}'.repeat((seq % 5) * 15)));
      log.record(recorded.at(-1)!);
      const replayed = log.since(0, all);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.length).toBeLessThanOrEqual(4);
      expect(replayed.reduce((sum, event) => sum + bytes(event), 0)).toBeLessThanOrEqual(limit);
      expect(replayed).toEqual(recorded.slice(-replayed.length));
      expect(log.earliestSeq('global')).toBe(replayed[0].seq);
    }
  });

  it('retains the exact wire envelopes at the byte boundary, then evicts the oldest prefix', () => {
    const recorded = [envelope(1), envelope(2), envelope(3)];
    const log = new RealtimeReplayLog(400, bytes(recorded[0]) * 2);
    log.record(recorded[0]);
    log.record(recorded[1]);
    expect(log.since(0, all)).toEqual(recorded.slice(0, 2));
    log.record(recorded[2]);
    expect(log.since(0, all)).toEqual(recorded.slice(1));
    expect(log.earliestSeq('global')).toBe(2);
  });

  it('counts UTF-8 bytes rather than JavaScript characters', () => {
    const event = envelope(1, '\u{1F9EA}'.repeat(50));
    const log = new RealtimeReplayLog(400, JSON.stringify(event).length);
    log.record(event);
    expect(log.since(0, all)).toEqual([]);
  });

  it('enforces the count limit even when the byte budget has room', () => {
    const log = new RealtimeReplayLog(2, 1024 * 1024);
    for (let i = 1; i <= 4; i += 1) log.record(envelope(i));
    expect(log.since(0, all).map((event) => event.seq)).toEqual([3, 4]);
  });

  it('clears the prefix for an oversized envelope and admits subsequent small events', () => {
    const log = new RealtimeReplayLog(400, 1024);
    log.record(envelope(1));
    log.record(envelope(2, 'large'.repeat(1024)));
    expect(log.earliestSeq('global')).toBeUndefined();
    log.record(envelope(3));
    expect(log.since(0, all)).toEqual([envelope(3)]);
  });

  it('releases the input graph and preserves JSON wire semantics', () => {
    const event = envelope(1);
    const log = new RealtimeReplayLog(400, 1024);
    log.record(event);
    if ('mutation' in event.data) event.data.mutation.note = 'changed after broadcast';
    expect(log.since(0, all)).toEqual([envelope(1)]);
  });

  it('isolates streams and capability audiences without decoding unrelated payloads', () => {
    const log = new RealtimeReplayLog(400, 4096);
    const legacy = { ...envelope(1), audience: 'mobile-inbox-legacy' as const };
    log.record(legacy);
    log.record(envelope(2, '', 'session:worker-a'));
    log.record(envelope(3));
    expect(log.earliestSeq('session:worker-a')).toBe(2);
    expect(log.since(0, (entry) => entry.stream === 'global' && !entry.audience)).toEqual([envelope(3)]);
    expect(log.since(2, all)).toEqual([envelope(3)]);
  });
});
