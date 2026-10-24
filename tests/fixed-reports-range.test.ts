/**
 * defaultRange() and releaseRange() — the ship-time ranges.
 *
 * release.mjs runs AFTER `npm version patch` has tagged HEAD, so a naive
 * `<latest-tag>..HEAD` is EMPTY at ship time — every Fixes-Report trailer
 * between the previous release and this one silently drops, and the receipt
 * loop never fires. defaultRange() serves ad-hoc publish:fixed runs, while
 * releaseRange() stays on the version tag when concurrent work advances HEAD.
 * Real-path test: a real temp git repo, real tags, the real range and
 * collectFixedIds() chain.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — plain .mjs build script, no type declarations by design
import { collectFixedIds, defaultRange, releaseRange } from '../scripts/lib/fixed-reports.mjs';

let repo: string;
let previousCwd: string;
let previousPath: string | undefined;
const releaseScript = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));

function published(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', ...extra };
}

function releases(pages: unknown[][]) {
  writeFileSync(path.join(repo, 'releases.json'), pages.flat().map(row => JSON.stringify(row)).join('\n'));
}

function releaseDryRun() {
  const out = path.join(repo, 'metadata.json');
  return execFileSync(process.execPath, [releaseScript, '--dry-run', '--out-dir', out], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, O8_RELEASE_CHANNEL: 'stable', O8_CHANGELOG_SOURCE_REF: 'HEAD' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

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
  previousPath = process.env.PATH;
  const bin = path.join(repo, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api' && args.some(arg => arg.includes('/releases?'))) {
  if (fs.existsSync('unavailable')) { console.error('fixture release evidence unavailable'); process.exit(1); }
  fs.appendFileSync('queries.jsonl', JSON.stringify(args) + '\\n');
  process.stdout.write(fs.readFileSync('releases.json'));
} else if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write('2026-10-02T00:00:00Z');
} else if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]');
} else { console.error('unexpected gh fixture call'); process.exit(1); }
`, { mode: 0o755 });
  // Capture the real CLI's metadata at its publication boundary. No publication
  // service, model, installed app, or operator data participates in this fixture.
  writeFileSync(path.join(bin, 'bash'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf('--latest-ship') + 1], args[args.indexOf('--out-dir') + 1]);
`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  releases([[published('v0.1.1'), published('v0.1.2')]]);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
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

describe('releaseRange — concurrent commit during ship', () => {
  it('stays anchored to the release tag when HEAD advances during the build', () => {
    commit('base');
    git(['tag', 'v0.1.1']);
    commit('fix: included in release\n\nFixes-Report: FYPPHK');
    commit('release: 0.1.2');
    git(['tag', 'v0.1.2']);
    commit('fix: concurrent session\n\nFixes-Report: LATER1');

    expect(releaseRange('v0.1.2')).toBe('v0.1.1..v0.1.2');
    expect([...collectFixedIds(releaseRange('v0.1.2')).keys()]).toEqual(['FYPPHK']);

    expect(defaultRange()).toBe('v0.1.2..HEAD');
    expect([...collectFixedIds(defaultRange()).keys()]).toEqual(['LATER1']);
  });
});

describe('releaseRange — verified published baseline', () => {
  function history() {
    commit('published base');
    git(['tag', 'v0.1.1']);
    commit('feat: keep earlier change (#101)\n\nFixes-Report: EARLY1');
    git(['tag', 'v0.1.2']); // never published
    commit('feat: keep later change (#102)\n\nFixes-Report: LATER2');
    git(['tag', 'v0.1.3']);
  }

  it('includes fixes and metadata before an unused tag, excludes later HEAD, and preserves tags', () => {
    history();
    releases([[published('v0.1.3')], [published('v0.1.1')]]);
    const tags = git(['show-ref', '--tags']);
    commit('feat: concurrent work\n\nFixes-Report: FUTURE');

    const range = releaseRange('v0.1.3');
    expect(range).toBe('v0.1.1..v0.1.3');
    expect([...collectFixedIds(range).keys()]).toEqual(['LATER2', 'EARLY1']);
    expect(git(['log', '--format=%s', range])).toContain('keep earlier change (#101)');
    expect(git(['show-ref', '--tags'])).toBe(tags);
  });

  it('uses the published baseline through the real release dry-run entry point', () => {
    history();
    releases([[published('v0.1.3')], [published('v0.1.1')]]);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.1.3' }));
    releaseDryRun();
    const metadata = JSON.parse(readFileSync(path.join(repo, 'metadata.json'), 'utf8'));
    expect(JSON.stringify(metadata)).toContain('Keep earlier change');
    expect(JSON.stringify(metadata)).toContain('Keep later change');
    const queries = readFileSync(path.join(repo, 'queries.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('--paginate');
  });

  it('ignores draft and preview releases even when their tags are closer', () => {
    history();
    releases([[published('v0.1.2', { draft: true }), published('v0.1.1')]]);
    expect(releaseRange('v0.1.3')).toBe('v0.1.1..v0.1.3');
    releases([[published('v0.1.2', { prerelease: true }), published('v0.1.1')]]);
    expect(releaseRange('v0.1.3')).toBe('v0.1.1..v0.1.3');
  });

  it('refuses unavailable publication evidence instead of guessing from local tags', () => {
    history();
    writeFileSync(path.join(repo, 'unavailable'), '');
    expect(() => releaseRange('v0.1.3')).toThrow(/published release/i);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.1.3' }));
    expect(() => releaseDryRun()).toThrow(/published release/i);
    expect(() => readFileSync(path.join(repo, 'metadata.json'))).toThrow();
  });

  it('refuses a missing published tag instead of selecting an older baseline', () => {
    history();
    releases([[published('v0.1.0'), published('v0.1.1')]]);
    expect(() => releaseRange('v0.1.3')).toThrow(/Fetch release tags and full history/);
  });

  it('skips published descendants when replaying an earlier release tag', () => {
    history();
    commit('future published release');
    git(['tag', 'v0.1.4']);
    releases([[published('v0.1.4'), published('v0.1.3'), published('v0.1.1')]]);
    expect(releaseRange('v0.1.3')).toBe('v0.1.1..v0.1.3');
  });

  it('refuses malformed evidence or history with no published ancestor', () => {
    history();
    writeFileSync(path.join(repo, 'releases.json'), 'invalid json');
    expect(() => releaseRange('v0.1.3')).toThrow(/published release/i);
    releases([[published('v0.1.1', { published_at: null })]]);
    expect(() => releaseRange('v0.1.3')).toThrow(/malformed release evidence/i);
    releases([]);
    expect(() => releaseRange('v0.1.3')).toThrow(/published release/i);
    releases([[published('v0.1.3')]]);
    expect(() => releaseRange('v0.1.3')).toThrow(/published release/i);
  });
});
