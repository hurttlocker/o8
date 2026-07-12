import { describe, expect, it } from 'vitest';

import {
  isWorktreeNoise,
  shouldRunConflictScan,
  type ConflictGateState,
} from './conflict-gate';

const base: ConflictGateState = {
  watchersActive: true,
  dirty: false,
  msSinceFullScan: 0,
  safetyNetMs: 60_000,
};

describe('shouldRunConflictScan', () => {
  it('skips the probe when watchers are live and nothing has changed — the whole point', () => {
    // This is the idle case, which is ~every tick. Before the gate existed, this
    // ran ~519ms of git subprocesses every 5 seconds, forever.
    expect(shouldRunConflictScan(base)).toBe(false);
  });

  it('runs the probe the moment a watcher fires', () => {
    expect(shouldRunConflictScan({ ...base, dirty: true })).toBe(true);
  });

  it('POLLS UNCONDITIONALLY when the watchers are not live', () => {
    // The safety valve. Without a change signal we cannot know whether anything
    // moved, so we must behave exactly as the old unconditional poll did.
    // Never worse than what this replaced.
    expect(shouldRunConflictScan({ ...base, watchersActive: false })).toBe(true);
    expect(
      shouldRunConflictScan({ ...base, watchersActive: false, dirty: false, msSinceFullScan: 0 }),
    ).toBe(true);
  });

  it('forces a probe once the safety net elapses, even if no watcher fired', () => {
    // A dropped or unwatched event must not strand the conflict report forever.
    expect(shouldRunConflictScan({ ...base, msSinceFullScan: 59_999 })).toBe(false);
    expect(shouldRunConflictScan({ ...base, msSinceFullScan: 60_000 })).toBe(true);
    expect(shouldRunConflictScan({ ...base, msSinceFullScan: 120_000 })).toBe(true);
  });

  it('never skips when dirty, whatever else is true', () => {
    for (const watchersActive of [true, false]) {
      for (const msSinceFullScan of [0, 30_000, 999_999]) {
        expect(
          shouldRunConflictScan({ ...base, dirty: true, watchersActive, msSinceFullScan }),
        ).toBe(true);
      }
    }
  });
});

describe('isWorktreeNoise', () => {
  it('ignores dependency and build churn — an npm install must not re-arm the probe', () => {
    expect(isWorktreeNoise('node_modules/react/index.js')).toBe(true);
    expect(isWorktreeNoise('pkt-1/node_modules/.bin/tsc')).toBe(true);
    expect(isWorktreeNoise('pkt-1/.next/cache/x')).toBe(true);
    expect(isWorktreeNoise('pkt-1/target/debug/foo')).toBe(true);
    expect(isWorktreeNoise('pkt-1/dist/bundle.js')).toBe(true);
    expect(isWorktreeNoise('pkt-1/coverage/lcov.info')).toBe(true);
    expect(isWorktreeNoise('pkt-1/.git/index')).toBe(true);
  });

  it('treats real source edits as real — this is the signal we exist to catch', () => {
    // An agent editing a file it has not staged yet. The .git watchers cannot
    // see this, which is exactly why the worktree trees are watched.
    expect(isWorktreeNoise('pkt-1/src/lib/foo.ts')).toBe(false);
    expect(isWorktreeNoise('pkt-1/README.md')).toBe(false);
    expect(isWorktreeNoise('.meta.json')).toBe(false);
  });

  it('does not match a path that merely CONTAINS a noise word', () => {
    // `node_modules_backup/` and `my-dist-plan.md` are real files.
    expect(isWorktreeNoise('pkt-1/node_modules_backup/a.ts')).toBe(false);
    expect(isWorktreeNoise('pkt-1/my-dist-plan.md')).toBe(false);
    expect(isWorktreeNoise('pkt-1/src/distributed.ts')).toBe(false);
    expect(isWorktreeNoise('pkt-1/src/building.ts')).toBe(false);
  });

  it('treats an unknown path as REAL — fail safe, never fail silent', () => {
    // fs.watch can coalesce an event and lose the filename. We cannot prove that
    // was noise, so it must re-arm the probe.
    expect(isWorktreeNoise(null)).toBe(false);
    expect(isWorktreeNoise(undefined)).toBe(false);
    expect(isWorktreeNoise('')).toBe(false);
  });
});
