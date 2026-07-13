/**
 * defaultRange() — the ship-time trap.
 *
 * release.mjs runs AFTER `npm version patch` has tagged HEAD, so a naive
 * `<latest-tag>..HEAD` is EMPTY at ship time — every Fixes-Report trailer
 * between the previous release and this one silently drops, and the receipt
 * loop never fires. Real-path test: a real temp git repo, real tags, the real
 * defaultRange()/collectFixedIds chain.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports
// @ts-expect-error — plain .mjs build script, no type declarations by design
import { collectFixedIds, defaultRange } from '../scripts/lib/fixed-reports.mjs';

let repo: string;
let previousCwd: string;

function git(args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(message: string) {
  writeFileSync(path.join(repo, 'f.txt'), `${message}\n${Math.random()}`);
  git(['add', 'f.txt']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message]);
}

beforeEach(() => {
  previousCwd = process.cwd();
  repo = mkdtempSync(path.join(os.tmpdir(), 'fixed-range-'));
  git(['init', '-q']);
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(repo, { recursive: true, force: true });
});

describe('defaultRange — ship-time tagged HEAD', () => {
  it('spans back to the PREVIOUS tag when HEAD is the freshly-minted release tag', () => {
    commit('base');
    git(['tag', 'v0.1.1']);
    commit('fix: something\n\nFixes-Report: A7F3K2');
    commit('release: 0.1.2');
    git(['tag', 'v0.1.2']); // ship flow: HEAD is tagged before release.mjs runs

    const range = defaultRange();
    expect(range).toBe('v0.1.1..HEAD');
    const ids = collectFixedIds(range);
    expect([...ids.keys()]).toEqual(['A7F3K2']); // the trailer is IN range
  });

  it('uses latest-tag..HEAD for the ad-hoc case (HEAD not tagged)', () => {
    commit('base');
    git(['tag', 'v0.1.1']);
    commit('fix: later\n\nFixes-Report: B2M9QP');

    const range = defaultRange();
    expect(range).toBe('v0.1.1..HEAD');
    expect([...collectFixedIds(range).keys()]).toEqual(['B2M9QP']);
  });

  it('falls back when the tagged HEAD is the only tag in history', () => {
    commit('only\n\nFixes-Report: C1D2E3');
    git(['tag', 'v0.1.0']);

    expect(defaultRange()).toBe('HEAD~20..HEAD');
  });
});
