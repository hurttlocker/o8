import { describe, expect, it } from 'vitest';

import {
  CI_REPAIR_MAX_PROMPT_CHARS,
  buildCiRepairRequest,
  ciRepairIsStale,
  failureExcerpt,
  type CiRepairCheck,
} from './prompt';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

function logWithFailureAt(lines: number, failAt: number): string {
  return Array.from({ length: lines }, (_, index) => {
    const text = index === failAt ? 'FAIL tests/merge.test.ts > keeps the lane' : `step output line ${index}`;
    return `2026-10-09T14:48:${String(index % 60).padStart(2, '0')}.1234567Z \u001b[32m${text}\u001b[39m`;
  }).join('\n');
}

function input(checks: CiRepairCheck[]) {
  return { repo: 'owner/repo', prNumber: 42, headSha: HEAD, branch: 'fix/42-thing', checks };
}

describe('CI repair prompt', () => {
  it('names the pull request, branch and head commit, and binds the target to them', () => {
    const request = buildCiRepairRequest(input([{ name: 'Type Check', workflow: 'CI', url: 'https://ci/1' }]));
    expect(request.title).toBe('Fix 1 failed CI check for owner/repo PR #42');
    expect(request.prompt).toContain('branch `fix/42-thing` at commit a1b2c3d4e5f6');
    expect(request.prompt).toContain('- CI / Type Check (https://ci/1)');
    expect(request.target).toEqual({
      repo: 'owner/repo',
      prNumber: 42,
      headSha: HEAD,
      branch: 'fix/42-thing',
      checks: [{ name: 'Type Check', workflow: 'CI', url: 'https://ci/1' }],
    });
  });

  it('stays inside the budget and keeps the instructions and check list when logs are huge', () => {
    const checks = Array.from({ length: 4 }, (_, index) => ({
      name: `Job ${index}`,
      workflow: 'CI',
      conclusion: 'failure',
      log: logWithFailureAt(5_000, 4_000),
    }));
    const request = buildCiRepairRequest(input(checks));
    expect(request.prompt.length).toBeLessThanOrEqual(CI_REPAIR_MAX_PROMPT_CHARS);
    expect(request.prompt).toContain('Do not change the workflow');
    for (const check of checks) expect(request.prompt).toContain(`- CI / ${check.name}`);
    expect(request.prompt.match(/FAIL tests\/merge\.test\.ts/g)).toHaveLength(4);
  });

  it('caps a long check list and says how many were left out', () => {
    const checks = Array.from({ length: 80 }, (_, index) => ({ name: `Matrix job ${index} ${'x'.repeat(60)}` }));
    const request = buildCiRepairRequest(input(checks));
    expect(request.prompt).toMatch(/- and \d+ more/);
    expect(request.target.checks).toHaveLength(80);
    expect(request.prompt.length).toBeLessThanOrEqual(CI_REPAIR_MAX_PROMPT_CHARS);
  });

  it('keeps the region around the last failure, without timestamps or color codes', () => {
    const excerpt = failureExcerpt(logWithFailureAt(200, 150), 400);
    expect(excerpt).toContain('FAIL tests/merge.test.ts > keeps the lane');
    expect(excerpt).toContain('step output line 153');
    expect(excerpt).not.toContain('step output line 160');
    expect(excerpt).not.toMatch(/\u001b|2026-10-09T/);
    expect(excerpt.length).toBeLessThanOrEqual(400);
  });

  it('falls back to the log tail when no line looks like a failure', () => {
    const excerpt = failureExcerpt('one\ntwo\nthree', 100);
    expect(excerpt).toBe('one\ntwo\nthree');
  });

  it('reports stale evidence when the pull request head moved', () => {
    const { target } = buildCiRepairRequest(input([{ name: 'Lint' }]));
    expect(ciRepairIsStale(target, HEAD)).toBe(false);
    expect(ciRepairIsStale(target, 'f'.repeat(40))).toBe(true);
    expect(ciRepairIsStale(target, null)).toBe(false);
  });
});
