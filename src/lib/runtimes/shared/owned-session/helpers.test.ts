import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  commandLineMatchesOwnedRun,
  filterStderrNoise,
  isOwnedRunAlive,
  relativeAge,
  repoSlugFromOrigin,
  writeJsonFile,
} from './helpers';
import type { OwnedRunRecord } from './types';

function makeRun(overrides: Partial<OwnedRunRecord>): OwnedRunRecord {
  return {
    id: 'run-1',
    mode: 'launch',
    prompt: 'x',
    startedAt: new Date(0).toISOString(),
    pid: process.pid, // this test process — definitively alive
    stdoutPath: '/dev/null',
    stderrPath: '/dev/null',
    outcome: 'running',
    ...overrides,
  } as OwnedRunRecord;
}

describe('repoSlugFromOrigin', () => {
  it('parses https and ssh GitHub remotes', () => {
    expect(repoSlugFromOrigin('https://github.com/hurttlocker/o8.git')).toBe('hurttlocker/o8');
    expect(repoSlugFromOrigin('https://github.com/hurttlocker/o8')).toBe('hurttlocker/o8');
    expect(repoSlugFromOrigin('git@github.com:hurttlocker/o8.git')).toBe('hurttlocker/o8');
  });

  it('returns undefined for non-GitHub or empty origins', () => {
    expect(repoSlugFromOrigin('https://gitlab.com/team/repo.git')).toBeUndefined();
    expect(repoSlugFromOrigin('')).toBeUndefined();
    expect(repoSlugFromOrigin(undefined)).toBeUndefined();
  });
});

describe('commandLineMatchesOwnedRun', () => {
  it('recognizes a persisted carrier wrapper instead of requiring the runtime binary name', () => {
    expect(commandLineMatchesOwnedRun('/usr/bin/ori codex exec --json', '/usr/bin/ori', 'codex')).toBe(true);
    expect(commandLineMatchesOwnedRun('/Users/J Doe/.local/bin/ori codex exec --json', '/Users/J Doe/.local/bin/ori', 'codex')).toBe(true);
    expect(commandLineMatchesOwnedRun('"/Users/J Doe/.local/bin/ori" codex exec --json', '/Users/J Doe/.local/bin/ori', 'codex')).toBe(true);
    expect(commandLineMatchesOwnedRun('/Users/J Doe/.local/bin/original codex exec --json', '/Users/J Doe/.local/bin/ori', 'codex')).toBe(false);
    expect(commandLineMatchesOwnedRun('/bin/sh -c "echo /usr/bin/ori"', '/usr/bin/ori', 'codex')).toBe(false);
    expect(commandLineMatchesOwnedRun('/usr/bin/ori codex exec --json', undefined, 'codex')).toBe(true);
    expect(commandLineMatchesOwnedRun('/usr/bin/node unrelated.js', 'ori', 'codex')).toBe(false);
    expect(commandLineMatchesOwnedRun('/usr/bin/origami codexical', 'ori', 'codex')).toBe(false);
    expect(commandLineMatchesOwnedRun('git fetch origin', 'ori', 'codex')).toBe(false);
    expect(commandLineMatchesOwnedRun('/Users/victoria/bin/node task.js', 'ori', 'codex')).toBe(false);
  });
});

describe('isOwnedRunAlive — finished runs are terminal (#1293)', () => {
  it('returns false for a finished run even with a live pid and a tmux session (no probe)', async () => {
    // A run that recorded a finish is terminal — the function must NOT fall
    // through to the live-pid check or the 3s tmux-bridge probe. Paying that
    // probe per dead run in a corpse flood is what wedged the inventory build.
    const finished = makeRun({
      finishedAt: new Date().toISOString(),
      outcome: 'finished',
      tmuxSession: 'o8-some-dead-session',
    });
    await expect(isOwnedRunAlive(finished)).resolves.toBe(false);
  });

  it('still reports a live pid alive when the run has not finished', async () => {
    const live = makeRun({ pid: process.pid });
    await expect(isOwnedRunAlive(live)).resolves.toBe(true);
  });

  it('returns false for a null/undefined run', async () => {
    await expect(isOwnedRunAlive(null)).resolves.toBe(false);
    await expect(isOwnedRunAlive(undefined)).resolves.toBe(false);
  });
});

describe('filterStderrNoise', () => {
  it('drops lines matching noise patterns and keeps the rest', () => {
    const raw = 'real error: spawn failed\nrmcp::transport::worker something worker quit\nsecond real line';
    const filtered = filterStderrNoise(raw, [/rmcp::transport::worker.*worker quit/i]);
    expect(filtered).toBe('real error: spawn failed\nsecond real line');
  });

  it('returns input untouched when no patterns are supplied', () => {
    expect(filterStderrNoise('anything\nat all', [])).toBe('anything\nat all');
  });
});

describe('writeJsonFile', () => {
  let tmpDir: string | null = null;

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes parseable JSON and leaves no .tmp files behind', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'o8-helpers-test-'));
    const target = path.join(tmpDir, 'session.json');

    await writeJsonFile(target, { surfaceId: 'codex-owned:abc', retryCount: 2 });
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    expect(parsed).toEqual({ surfaceId: 'codex-owned:abc', retryCount: 2 });

    // Overwrite must replace atomically (write-then-rename), not append/tear.
    await writeJsonFile(target, { surfaceId: 'codex-owned:abc', retryCount: 3 });
    const reparsed = JSON.parse(await readFile(target, 'utf8'));
    expect(reparsed.retryCount).toBe(3);

    const leftovers = (await readdir(tmpDir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('relativeAge', () => {
  it('does not render NaN for a timestamp it cannot parse', () => {
    // o8_status showed a just-launched agent as "NaNd ago" because every
    // comparison against NaN is false, so all four bucket guards fell through
    // to the day branch (#1859).
    for (const bad of ['', 'not-a-date', '2026-13-45T99:99:99Z', 'undefined']) {
      const rendered = relativeAge(bad);
      expect(rendered).not.toContain('NaN');
      expect(rendered).toBe('just now');
    }
  });

  it('still buckets real timestamps', () => {
    const now = Date.now();
    expect(relativeAge(new Date(now - 5_000).toISOString())).toBe('just now');
    expect(relativeAge(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(relativeAge(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(relativeAge(new Date(now - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });

  it('treats a missing stamp the same as an unparseable one', () => {
    expect(relativeAge(undefined)).toBe('just now');
  });
});
