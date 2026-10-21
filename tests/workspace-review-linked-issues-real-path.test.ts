import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';

let root: string;
let repo: string;
let callsPath: string;
let fixturePath: string;
const slug = 'example/widgets';

function pullRequest(number: number, body: string) {
  return {
    number, body, title: `Change ${number}`, state: 'OPEN',
    url: `https://github.com/${slug}/pull/${number}`,
    headRefName: number === 7 ? 'feature' : 'dependency-update', baseRefName: 'main',
  };
}

function setPullRequests(body: string | null, fallbackBody = 'Closes #99') {
  writeFileSync(`${fixturePath}.branch`, JSON.stringify(body === null ? [] : [pullRequest(7, body)]));
  writeFileSync(`${fixturePath}.fallback`, JSON.stringify([pullRequest(8, fallbackBody)]));
}

function calls(kind?: string): string[][] {
  return readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.split(' '))
    .filter((args) => args[0] !== 'auth' && (!kind || args[0] === kind));
}

async function routeRead() {
  const { GET } = await import('@/app/api/review/workspace/route');
  const query = new URLSearchParams({ workspace: repo });
  const response = await GET(new Request(`http://localhost/api/review/workspace?${query}`));
  expect(response.status).toBe(200);
  return await response.json() as WorkflowReviewSnapshot;
}

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(path.join(os.tmpdir(), 'workspace-linked-issues-'));
  repo = path.join(root, 'repo');
  callsPath = path.join(root, 'calls.jsonl');
  fixturePath = path.join(root, 'prs.json');
  execFileSync('git', ['init', '-b', 'feature', repo]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: repo });
  writeFileSync(callsPath, '');
  const gh = path.join(root, 'gh');
  writeFileSync(gh, `#!/bin/sh
printf '%s\\n' "$*" >> "$REVIEW_FIXTURE_CALLS"
case "$1" in
  auth) printf 'fixture-credential\\n' ;;
  pr)
    case " $* " in
      *' --head '*) cat "$REVIEW_FIXTURE_PRS.branch" ;;
      *) cat "$REVIEW_FIXTURE_PRS.fallback" ;;
    esac ;;
  api) printf '[]\\n' ;;
  issue) printf '{"number":%s,"title":"Issue %s","state":"OPEN","url":"https://github.com/example/widgets/issues/%s"}\\n' "$3" "$3" "$3" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(gh, 0o755);
  vi.stubEnv('PATH', `${root}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv('REVIEW_FIXTURE_CALLS', callsPath);
  vi.stubEnv('REVIEW_FIXTURE_PRS', fixturePath);
  // The legacy setting must not bypass branch-only issue eligibility.
  vi.stubEnv('CORTEX_IDE_ACTIVE_REVIEW_ISSUE', '999');
  setPullRequests(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace review linked issues through the real route and Git repository', () => {
  it('makes zero issue reads for unrelated fallback PR bodies across full refreshes', async () => {
    const changelog = Array.from({ length: 35 }, (_, i) => `Upstream change #${100 + i}`).join('\n');
    setPullRequests(null, `Closes #99\n${changelog}`);
    const first = await routeRead();
    expect(first.branch).toBe('feature');
    expect(first.repoSlug).toBe(slug);
    expect(first.pullRequests.map((pr) => pr.number)).toEqual([8]);
    expect(first.activeIssues).toEqual([]);
    expect(calls('issue')).toEqual([]);
    expect(calls('pr')).toHaveLength(2);
    expect(calls('api')).toHaveLength(1);
    const { invalidateReviewSnapshotCache } = await import('@/lib/review/workspace');
    for (let i = 0; i < 3; i += 1) {
      invalidateReviewSnapshotCache();
      await routeRead();
    }
    expect(calls()).toHaveLength(3);
  });

  it('resolves only Closes #12 amid pasted changelog and foreign closing references', async () => {
    setPullRequests('Closes #12\nChangelog: #56 #78 #90\nFixes other/repo#81\nResolves https://github.com/other/repo/issues/82');
    const result = await routeRead();
    expect(calls('issue').map((args) => args[2])).toEqual(['12']);
    expect(result.activeIssues?.map((issue) => issue.number)).toEqual([12]);
    expect(result.pullRequests[0].linkedIssueNumbers).toEqual([12]);
    const before = calls().length;
    const { invalidateReviewSnapshotCache } = await import('@/lib/review/workspace');
    invalidateReviewSnapshotCache();
    await routeRead();
    expect(calls()).toHaveLength(before);
  });

  it.each(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'])(
    'accepts the %s closing keyword without reading ordinary references', async (keyword) => {
      setPullRequests(`${keyword.toUpperCase()} #12\nRefs #88`);
      await routeRead();
      expect(calls('issue').map((args) => args[2])).toEqual(['12']);
    },
  );

  it('deduplicates closing references and caps issue reads at three', async () => {
    setPullRequests('Closes #12\nFixes #12\nResolves #13\nClosed #14\nFixed #15\nResolved #16');
    const result = await routeRead();
    const numbers = calls('issue').map((args) => Number(args[2]));
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.every((number) => [12, 13, 14, 15, 16].includes(number))).toBe(true);
    expect(result.activeIssues).toHaveLength(3);
  });

  it('accepts same-repository closing links and qualified references case-insensitively', async () => {
    setPullRequests('Fixes EXAMPLE/Widgets#12\nResolves https://github.com/example/widgets/issues/13\nCloses other/repo#14');
    const result = await routeRead();
    expect(calls('issue').map((args) => Number(args[2])).sort()).toEqual([12, 13]);
    expect(result.activeIssues?.map((issue) => issue.number).sort()).toEqual([12, 13]);
  });

  it('does not substitute a legacy active issue when the branch PR has no closing references', async () => {
    setPullRequests('Related #56, upstream/repo#78');
    expect((await routeRead()).activeIssues).toEqual([]);
    expect(calls('issue')).toEqual([]);
  });
});
