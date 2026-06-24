import { describe, it, expect } from 'vitest';
import { interruptableSessions } from './reap-sessions';

// #1292 — the pure "what to reap before nulling sessionKey" capture. If this
// drops a live session, reset leaves an orphan codex exec that the supervisor
// auto-retries into a sibling lane (the zombie-multiply bug).
const lane = (id: string, sessionKey: string | null, runtime = 'codex') =>
  ({ id, sessionKey, runtime }) as unknown as Parameters<typeof interruptableSessions>[0][number];

describe('interruptableSessions (#1292 reap-before-null)', () => {
  it('captures (laneId, runtime, sessionKey) for every lane with a live session', () => {
    expect(interruptableSessions([lane('l1', 'sk1'), lane('l2', 'sk2', 'gemini')])).toEqual([
      { laneId: 'l1', runtime: 'codex', sessionKey: 'sk1' },
      { laneId: 'l2', runtime: 'gemini', sessionKey: 'sk2' },
    ]);
  });

  it('skips lanes with no/blank sessionKey (nothing to reap)', () => {
    expect(interruptableSessions([lane('l1', null), lane('l2', ''), lane('l3', '   ')])).toEqual([]);
  });

  it('trims the sessionKey', () => {
    expect(interruptableSessions([lane('l1', '  sk1  ')])).toEqual([
      { laneId: 'l1', runtime: 'codex', sessionKey: 'sk1' },
    ]);
  });

  it('empty input → empty', () => {
    expect(interruptableSessions([])).toEqual([]);
  });
});
