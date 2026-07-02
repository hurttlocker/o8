/**
 * Activity feed local-git fallback (#1341), driven through the REAL commits
 * route handler against a real temp git repo — not getRecentWorkspaceCommits
 * in isolation.
 *
 * WHY THIS SHAPE — the reachability rule. The bug was that the Activity tab
 * keyed every fetch off a GitHub slug, so a locally-added repo (no remote,
 * no mirror rows) rendered "No activity yet" despite having local history.
 * The fix routes commits through the commits route's `?workspace=<path>`
 * branch, which reads local git. This test builds a real repo with real
 * commits and drives GET() the way fetchRepoActivity() does, asserting the
 * route returns the on-disk history so the feed can never be falsely empty.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const { GET } = await import('@/app/api/panel/commits/route');

function initRepoWithCommits(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'o8-activity-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git('init', '-q');
  git('config', 'user.email', 'test@o8.dev');
  git('config', 'user.name', 'O8 Test');
  git('commit', '--allow-empty', '-q', '-m', 'first local commit');
  git('commit', '--allow-empty', '-q', '-m', 'second local commit');
  git('commit', '--allow-empty', '-q', '-m', 'third local commit');
  return dir;
}

describe('activity feed local-git fallback (#1341)', () => {
  it('serves local commit history for a workspace path with no GitHub mirror', async () => {
    const dir = initRepoWithCommits();
    const req = new NextRequest(
      `http://127.0.0.1/api/panel/commits?workspace=${encodeURIComponent(dir)}&limit=50`,
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.commits)).toBe(true);
    expect(body.commits.length).toBe(3);

    const subjects = body.commits.map((c: { subject?: string; message?: string }) => c.subject ?? c.message);
    expect(subjects).toContain('first local commit');
    expect(subjects).toContain('third local commit');

    // The activity mapper reads shortSha + date off each row.
    expect(typeof body.commits[0].shortSha).toBe('string');
    expect(body.commits[0].shortSha.length).toBeGreaterThan(0);
    expect(typeof body.commits[0].date).toBe('string');
  });

  it('returns an empty (not errored) list for a path with no git history', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'o8-activity-nogit-'));
    const req = new NextRequest(
      `http://127.0.0.1/api/panel/commits?workspace=${encodeURIComponent(dir)}&limit=50`,
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.commits).toEqual([]);
  });
});
