/**
 * activeAgentSession registry (docs/symon-agent-mode.md §"Session registry" +
 * §"Mutual exclusion"). Covers last-start-wins, terminal-status clearing, the
 * 10-min stale sweep, and the cross-process disk mirror the Next GET reads.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-symon-reg-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  startAgentSession,
  updateAgentStatus,
  touchAgentSession,
  stopAgentSession,
  sweepStaleAgentSession,
  getAgentSession,
  isAgentSessionStale,
  persistAgentSession,
  loadPersistedAgentSession,
  AGENT_SESSION_STALE_MS,
} = await import('./symon-agent-registry');

beforeEach(() => {
  stopAgentSession(); // reset the globalThis singleton between cases
});

describe('symon-agent-registry — last-start-wins', () => {
  it('first start has no preemption and sets connecting', () => {
    const { record, preempted } = startAgentSession('sym-a', 1_000);
    expect(preempted).toBeNull();
    expect(record).toMatchObject({ sessionId: 'sym-a', startedAt: 1_000, lastStatus: 'connecting', source: 'phone' });
    expect(getAgentSession()?.sessionId).toBe('sym-a');
  });

  it('a second, DIFFERENT start preempts the first and returns its id', () => {
    startAgentSession('sym-a', 1_000);
    const { preempted } = startAgentSession('sym-b', 2_000);
    expect(preempted).toBe('sym-a');
    expect(getAgentSession()?.sessionId).toBe('sym-b');
  });

  it('re-registering the SAME id is idempotent and keeps startedAt', () => {
    startAgentSession('sym-a', 1_000);
    const { preempted, record } = startAgentSession('sym-a', 5_000);
    expect(preempted).toBeNull();
    expect(record.startedAt).toBe(1_000); // original start preserved
  });
});

describe('symon-agent-registry — status transitions', () => {
  it('updates lastStatus + activity for the active session', () => {
    startAgentSession('sym-a', 1_000);
    const updated = updateAgentStatus('sym-a', 'live', 3_000);
    expect(updated).toMatchObject({ lastStatus: 'live', lastActivityAt: 3_000 });
  });

  it('a terminal status (idle/error) clears the registry', () => {
    startAgentSession('sym-a', 1_000);
    expect(updateAgentStatus('sym-a', 'idle', 2_000)).toBeNull();
    expect(getAgentSession()).toBeNull();
  });

  it('ignores a status for a non-active session id (preempted late chatter)', () => {
    startAgentSession('sym-b', 1_000);
    expect(updateAgentStatus('sym-a', 'live', 2_000)).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-b'); // untouched
  });

  it('touchAgentSession bumps activity only for the active id', () => {
    startAgentSession('sym-a', 1_000);
    touchAgentSession('sym-a', 9_000);
    expect(getAgentSession()?.lastActivityAt).toBe(9_000);
    expect(touchAgentSession('sym-x', 10_000)).toBeNull();
  });
});

describe('symon-agent-registry — stop + stale sweep', () => {
  it('stopAgentSession only clears a matching id (else no-op)', () => {
    startAgentSession('sym-a', 1_000);
    expect(stopAgentSession('sym-x')).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-a');
    expect(stopAgentSession('sym-a')?.sessionId).toBe('sym-a');
    expect(getAgentSession()).toBeNull();
  });

  it('sweeps a session gone quiet past the 10-min TTL', () => {
    startAgentSession('sym-a', 0);
    updateAgentStatus('sym-a', 'live', 0);
    // Not yet stale.
    expect(sweepStaleAgentSession(AGENT_SESSION_STALE_MS - 1)).toBeNull();
    expect(getAgentSession()?.sessionId).toBe('sym-a');
    // Past the TTL → dropped.
    const dropped = sweepStaleAgentSession(AGENT_SESSION_STALE_MS + 1);
    expect(dropped?.sessionId).toBe('sym-a');
    expect(getAgentSession()).toBeNull();
  });

  it('isAgentSessionStale respects the TTL boundary', () => {
    const rec = startAgentSession('sym-a', 0).record;
    expect(isAgentSessionStale(rec, AGENT_SESSION_STALE_MS)).toBe(false);
    expect(isAgentSessionStale(rec, AGENT_SESSION_STALE_MS + 1)).toBe(true);
  });
});

describe('symon-agent-registry — disk mirror (cross-process)', () => {
  it('persists + loads the current record, and applies the staleness guard on load', () => {
    startAgentSession('sym-a', 1_000);
    const live = updateAgentStatus('sym-a', 'live', 1_000)!;
    persistAgentSession(live);

    const loaded = loadPersistedAgentSession(2_000);
    expect(loaded).toMatchObject({ sessionId: 'sym-a', lastStatus: 'live', startedAt: 1_000 });

    // A crashed writer can't leave a phantom banner: a stale mirror loads as null.
    expect(loadPersistedAgentSession(1_000 + AGENT_SESSION_STALE_MS + 1)).toBeNull();
  });

  it('persisting null clears the mirror', () => {
    startAgentSession('sym-a', 1_000);
    persistAgentSession(getAgentSession());
    persistAgentSession(null);
    expect(loadPersistedAgentSession(1_500)).toBeNull();
  });
});
