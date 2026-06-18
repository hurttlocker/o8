import { describe, it, expect } from 'vitest';
import { OrchestratorReplayBuffers, type OrchestratorReplayMessage } from './replay-buffer';

const mk = (event: string, data: Record<string, unknown>): OrchestratorReplayMessage => ({
  channel: 'orchestrator',
  event,
  data,
});

describe('OrchestratorReplayBuffers', () => {
  it('stamps a monotonic seq and replays only events after the since cursor', () => {
    const b = new OrchestratorReplayBuffers();
    b.record('s', mk('status', { status: 'busy' })); // seq 1
    b.record('s', mk('output', { text: 'a' })); // seq 2
    b.record('s', mk('output', { text: 'b' })); // seq 3

    expect(b.since('s', 0)).toHaveLength(3); // fresh client → full replay
    const tail = b.since('s', 2);
    expect(tail).toHaveLength(1);
    const parsed = JSON.parse(tail[0]);
    expect(parsed.seq).toBe(3);
    expect(parsed.data.text).toBe('b');
  });

  it('stamps seq onto the outgoing message (so the client can advance its cursor)', () => {
    const b = new OrchestratorReplayBuffers();
    const raw = b.record('s', mk('output', { text: 'x' }));
    expect(JSON.parse(raw).seq).toBe(1);
  });

  it('a new turn (status:busy) starts the buffer fresh but keeps seq monotonic', () => {
    const b = new OrchestratorReplayBuffers();
    b.record('s', mk('status', { status: 'busy' })); // 1
    b.record('s', mk('output', { text: 'old' })); // 2
    b.record('s', mk('status', { status: 'ready' })); // 3 → clears entries
    expect(b.since('s', 0)).toEqual([]);

    b.record('s', mk('status', { status: 'busy' })); // 4 → fresh turn
    const raw = b.record('s', mk('output', { text: 'new' })); // 5
    expect(JSON.parse(raw).seq).toBe(5); // monotonic across turns
    expect(b.since('s', 0)).toHaveLength(2); // [busy(4), output(5)]
    // a client whose cursor is stuck at the old turn still gets the new turn
    expect(b.since('s', 3)).toHaveLength(2);
  });

  it('drops entries when a turn finishes (no post-turn replay → no dup with history)', () => {
    const b = new OrchestratorReplayBuffers();
    b.record('s', mk('status', { status: 'busy' }));
    b.record('s', mk('output', { text: 'reply' }));
    b.record('s', mk('status', { status: 'ready' }));
    expect(b.since('s', 0)).toEqual([]);
  });

  it('drops entries on an error event too', () => {
    const b = new OrchestratorReplayBuffers();
    b.record('s', mk('status', { status: 'busy' }));
    b.record('s', mk('output', { text: 'partial' }));
    b.record('s', mk('error', { error: 'boom' }));
    expect(b.since('s', 0)).toEqual([]);
  });

  it('caps the buffer to the last N entries (long turn keeps its tail)', () => {
    const b = new OrchestratorReplayBuffers(3);
    b.record('s', mk('status', { status: 'busy' }));
    for (let i = 0; i < 10; i++) b.record('s', mk('output', { text: String(i) }));
    const replay = b.since('s', 0);
    expect(replay).toHaveLength(3);
    expect(JSON.parse(replay[2]).data.text).toBe('9'); // newest survives
  });

  it('keeps buffers isolated per session', () => {
    const b = new OrchestratorReplayBuffers();
    b.record('a', mk('status', { status: 'busy' }));
    b.record('a', mk('output', { text: 'in-a' }));
    b.record('b', mk('status', { status: 'busy' }));
    expect(b.since('a', 0)).toHaveLength(2);
    expect(b.since('b', 0)).toHaveLength(1);
    expect(b.since('unknown', 0)).toEqual([]);
  });
});
