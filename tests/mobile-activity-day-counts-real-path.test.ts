/**
 * Mobile "Last 7 days" commit counts (#2407), driven through the REAL
 * /api/mobile/activity GET handler against real git repositories registered
 * with addRepo, the way the desktop registers tracked repos.
 *
 * The receipts list is capped (20 commits per repo, 40 events overall), so a
 * chart built from it covers only the newest commits. The fixture puts more
 * commits in the window than the event cap and spreads them across days,
 * including a day with none, and asserts every day's count is exact while the
 * receipts stay capped.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-activity-day-counts-'));
const dataDir = path.join(root, 'data');
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const DAY_MS = 24 * 60 * 60 * 1000;
const todayUtcMidnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

function dateKey(daysBack: number): string {
  return new Date(todayUtcMidnight - daysBack * DAY_MS).toISOString().slice(0, 10);
}

/** Commits per UTC day, keyed by days before today. Oldest entries first. */
function fixtureRepo(name: string, plan: Array<[daysBack: number, count: number, minuteOfDay?: number]>): string {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath);
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: repoPath, env: { ...process.env, ...env } });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'o8-test']);
  git(['config', 'user.email', 'test@invalid']);
  let serial = 0;
  for (const [daysBack, count, minuteOfDay = 1] of plan) {
    for (let index = 0; index < count; index += 1) {
      serial += 1;
      const when = new Date(
        todayUtcMidnight - daysBack * DAY_MS + minuteOfDay * 60_000 + index * 1000,
      ).toISOString();
      git(['commit', '--allow-empty', '-q', '-m', `${name} commit ${serial}`], {
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_DATE: when,
      });
    }
  }
  return repoPath;
}

const { addRepo } = await import('@/lib/repos/registry');
const { GET } = await import('@/app/api/mobile/activity/route');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe('mobile activity per-day commit counts (#2407)', () => {
  it('counts every day of the window from a dated query while receipts stay capped', async () => {
    await addRepo(fixtureRepo('busy-repo', [
      [9, 6], // outside the window, never counted
      [7, 5],
      // 6 days back: no commits
      [5, 3],
      [4, 12],
      [3, 4],
      [2, 10],
      [1, 7],
      [1, 1, 23 * 60 + 30], // late in the UTC day, still yesterday in UTC
      [0, 5],
    ]));
    await addRepo(fixtureRepo('yesterday-repo', [[1, 21]]));
    await addRepo(fixtureRepo('today-repo', [[0, 21]]));

    const response = await GET(new Request('http://127.0.0.1:47120/api/mobile/activity'));
    expect(response.status).toBe(200);
    const payload = await response.json();

    // Receipts: 20 per repo x 3 repos = 60 candidates, capped at 40.
    expect(payload.events).toHaveLength(40);

    expect(payload.commitCounts).toEqual({
      utcOffsetMinutes: 0,
      days: [
        { date: dateKey(7), count: 5 },
        { date: dateKey(6), count: 0 },
        { date: dateKey(5), count: 3 },
        { date: dateKey(4), count: 12 },
        { date: dateKey(3), count: 4 },
        { date: dateKey(2), count: 10 },
        { date: dateKey(1), count: 29 },
        { date: dateKey(0), count: 26 },
      ],
    });
  }, 60_000);

  it('buckets at the offset the phone passes', async () => {
    // +60 minutes: the 23:30 UTC commit from yesterday lands on today's local date.
    const response = await GET(new Request(
      'http://127.0.0.1:47120/api/mobile/activity?utcOffsetMinutes=60',
    ));
    const payload = await response.json();

    expect(payload.commitCounts.utcOffsetMinutes).toBe(60);
    expect(payload.commitCounts.days).toHaveLength(8);
    const today = payload.commitCounts.days[7];
    const yesterday = payload.commitCounts.days[6];
    const localToday = new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 10);
    expect(today.date).toBe(localToday);
    if (localToday === dateKey(0)) {
      expect(yesterday).toEqual({ date: dateKey(1), count: 28 });
      expect(today).toEqual({ date: dateKey(0), count: 27 });
    }
    expect(payload.events).toHaveLength(40);
  }, 60_000);
});
