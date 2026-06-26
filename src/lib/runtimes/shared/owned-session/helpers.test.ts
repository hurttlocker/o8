import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  filterStderrNoise,
  isOwnedRunAlive,
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
