/**
 * Contributor credit in public release copy (#3459).
 *
 * The changelog half drives `scripts/sync-public-changelog.sh` itself in its
 * `--format-only` mode, so the assertions run against the filter and format
 * the publisher actually uses. The latest-ship half drives `buildLatestShip`,
 * the function the release script publishes from.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  contributorCreditLine,
  creditsForSubjects,
  pullNumberFromSubject,
  resolveContributorCredits,
} from '../scripts/lib/contributor-credits.mjs';
import { buildLatestShip } from '../scripts/lib/public-release.mjs';

const SCRIPT = join(__dirname, '..', 'scripts', 'sync-public-changelog.sh');

function formatEntries(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const out = execFileSync('bash', [SCRIPT, '--format-only'], {
    input: `${rows.map(([subject, login]) => `${subject}\t${login}`).join('\n')}\n`,
    encoding: 'utf8',
  });
  return out.split('\n').slice(0, rows.length);
}

const PERMISSIONS: Record<string, string> = {
  owner: 'admin',
  helper: 'write',
  outside: 'read',
  second: 'triage',
};

function lookups(authors: Record<number, { login: string; isBot?: boolean }>) {
  const calls: string[] = [];
  return {
    calls,
    pullAuthors: new Map(Object.entries(authors).map(([n, a]) => [Number(n), { isBot: false, ...a }])),
    permissionFor: (login: string) => {
      calls.push(login);
      const permission = PERMISSIONS[login];
      if (!permission) throw new Error('not found');
      return permission;
    },
  };
}

describe('contributor credit resolution', () => {
  it('reads the pull request from a squash subject, including a [via-o8] marker', () => {
    expect(pullNumberFromSubject('fix: keep the pane (#3401)')).toBe(3401);
    expect(pullNumberFromSubject('docs: record v0.1.771 (#2826) (#2827)')).toBe(2827);
    expect(pullNumberFromSubject('feat: show checks (#3403) [via-o8]')).toBe(3403);
    expect(pullNumberFromSubject('fix: no pull request here')).toBeNull();
  });

  it('credits outside authors only, and looks each login up once', () => {
    const lookup = lookups({
      1: { login: 'outside' },
      2: { login: 'owner' },
      3: { login: 'helper' },
      4: { login: 'dependabot[bot]', isBot: true },
      5: { login: 'outside' },
      6: { login: 'second' },
      7: { login: 'gone' },
    });
    expect(resolveContributorCredits([1, 2, 3, 4, 5, 6, 7, 8], lookup)).toEqual({
      1: 'outside',
      5: 'outside',
      6: 'second',
    });
    expect(lookup.calls.filter((login) => login === 'outside')).toHaveLength(1);
  });

  it('skips the credit when a permission lookup fails', () => {
    const lookup = lookups({ 9: { login: 'gone' } });
    expect(creditsForSubjects(['fix: a thing (#9)'], lookup)).toEqual({});
  });

  it('writes one thank-you sentence for the release body', () => {
    expect(contributorCreditLine({})).toBe('');
    expect(contributorCreditLine({ 1: 'outside' })).toBe('Thanks to @outside for their pull request in this release.');
    expect(contributorCreditLine({ 1: 'outside', 5: 'outside', 6: 'second' })).toBe(
      'Thanks to @outside and @second for their pull requests in this release.',
    );
    expect(contributorCreditLine({ 1: 'c', 2: 'a', 3: 'b' })).toBe(
      'Thanks to @a, @b, and @c for their pull requests in this release.',
    );
  });
});

describe('public changelog credit', () => {
  it('publishes a credited fix with the handle and keeps uncredited fixes private', () => {
    expect(formatEntries([
      ['fix: keep the terminal open after a worker exits (#3401)', 'outside'],
      ['fix: keep the terminal open after a worker exits (#3402)', ''],
      ['feat: show pull request checks in the inbox (#3403) [via-o8]', 'outside'],
      ['feat: Symon uses the new dock (#3404)', ''],
      ['fix: stop writing the password into logs (#3405)', 'outside'],
      ['chore: bump a dependency (#3406)', 'outside'],
    ])).toEqual([
      'fix: keep the terminal open after a worker exits — thanks @outside',
      '',
      'feat: show pull request checks in the inbox [via-o8] — thanks @outside',
      'feat: voice agent uses the new dock',
      '',
      '',
    ]);
  });
});

describe('latest ship credit', () => {
  const base = {
    version: '0.1.790',
    tag: 'v0.1.790',
    publishedAt: '2026-10-09T12:00:00.000Z',
    releaseUrl: 'https://github.com/hurttlocker/o8/releases/tag/v0.1.790',
  };

  it('thanks the contributor on their item and nowhere else', () => {
    const ship = buildLatestShip({
      ...base,
      commits: [
        { sha: 'a'.repeat(40), subject: 'feat: open every repository in one project (#10)' },
        { sha: 'b'.repeat(40), subject: 'fix: keep the terminal open after a worker exits (#11)' },
      ],
      credits: { 11: 'outside' },
    });
    const items = ship.sections.flatMap((section) => section.items);
    expect(items).toContain('Keep the terminal open after a worker exits (thanks @outside)');
    expect(items).toContain('Open every repository in one project');
    expect(ship.title).toBe('Open every repository in one project');
    expect(ship.summary).not.toContain('@');
  });

  it('keeps a credited fix inside the eight-item cap', () => {
    const commits = Array.from({ length: 10 }, (_, index) => ({
      sha: `${index}`.repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, 'a'),
      subject: `fix: repair surface number ${index} (#${100 + index})`,
    }));
    const ship = buildLatestShip({ ...base, commits, credits: { 109: 'outside' } });
    const fixes = ship.sections.find((section) => section.title === 'Fixes');
    expect(fixes?.items).toHaveLength(8);
    expect(fixes?.items[0]).toBe('Repair surface number 9 (thanks @outside)');
  });

  it('keeps the credit whole when the item is at the length limit', () => {
    const long = `fix: ${'very long description '.repeat(20)}(#12)`;
    const ship = buildLatestShip({
      ...base,
      commits: [{ sha: 'c'.repeat(40), subject: long }],
      credits: { 12: 'outside' },
    });
    const item = ship.sections[0].items[0];
    expect(item.length).toBeLessThanOrEqual(220);
    expect(item.endsWith(' (thanks @outside)')).toBe(true);
  });
});
