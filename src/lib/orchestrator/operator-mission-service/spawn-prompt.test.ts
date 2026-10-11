import { describe, expect, it } from 'vitest';

import { isInlineIssue, slugify } from './shared';
import {
  buildInlineIssuesFromPrompt,
  resolveSpawnCount,
  assertSpawnBatchMaterializable,
} from './spawn-prompt';

describe('resolveSpawnCount', () => {
  it('defaults only an omitted count to 1 and preserves explicit counts', () => {
    expect(resolveSpawnCount(undefined)).toBe(1);
    expect(resolveSpawnCount(20)).toBe(20);
    expect(resolveSpawnCount(50)).toBe(50);
  });

  it.each([null, '2', true, 0, -3, 2.9, Number.NaN, Infinity, 1e100].map((count) => [count]))('rejects malformed count %j', (count) => {
    expect(() => resolveSpawnCount(count)).toThrow(/positive safe integer/);
  });

  it('rejects impossible materialization before allocating the array', () => {
    expect(() => assertSpawnBatchMaterializable('x', 1_000_000_000)).toThrow(/capacity/);
    expect(() => buildInlineIssuesFromPrompt('x', Number.MAX_SAFE_INTEGER)).toThrow(/capacity/);
  });
});

describe('buildInlineIssuesFromPrompt', () => {
  it('rejects an empty task', () => {
    expect(() => buildInlineIssuesFromPrompt('   ')).toThrow(/task is required/);
  });

  it('synthesizes a single inline issue that passes isInlineIssue', () => {
    const [issue, ...rest] = buildInlineIssuesFromPrompt('Refactor the auth module');
    expect(rest).toHaveLength(0);
    // Unique time-based synthetics (pipeline root fix 2026-07-03) — fixed
    // 90001+index numbers made every inline mission collide with every prior
    // one, and branch cleanup archived the older mission's live lanes.
    expect(issue.number).toBeGreaterThanOrEqual(90001);
    expect(issue.url).toBe('');
    expect(issue.title).toBe('Refactor the auth module');
    expect(issue.body).toBe('Refactor the auth module');
    expect(isInlineIssue(issue)).toBe(true);
  });

  it('derives the title from the first non-empty line and keeps the full body', () => {
    const task = '\n  Add token rotation  \nplus a regression test for expiry';
    const [issue] = buildInlineIssuesFromPrompt(task);
    expect(issue.title).toBe('Add token rotation');
    expect(issue.body).toBe('Add token rotation  \nplus a regression test for expiry'.trim());
  });

  it('truncates an over-long title but never the body', () => {
    const longLine = 'a'.repeat(200);
    const [issue] = buildInlineIssuesFromPrompt(longLine);
    expect(issue.title.length).toBeLessThanOrEqual(72);
    expect(issue.title.endsWith('…')).toBe(true);
    expect(issue.body).toBe(longLine);
  });

  it('uniquifies titles for a multi-agent race so branch slugs do not collide', () => {
    const issues = buildInlineIssuesFromPrompt('the auth refactor', 3);
    expect(issues).toHaveLength(3);
    const numbers = issues.map((i) => i.number);
    expect(new Set(numbers).size).toBe(3); // unique within the batch
    for (const n of numbers) expect(n).toBeGreaterThanOrEqual(90001); // still isInlineIssue
    // and unique ACROSS creations — the collision that archived live lanes:
    const again = buildInlineIssuesFromPrompt('same task', 3).map((i) => i.number);
    expect(again.some((n) => numbers.includes(n))).toBe(false);
    issues.forEach((issue) => expect(isInlineIssue(issue)).toBe(true));

    // Every agent shares the body but carries a distinct (i/N) title. The
    // mission branch target also carries the unique inline issue number.
    const slugs = new Set(issues.map((i) => slugify(i.title)));
    expect(slugs.size).toBe(3);
    issues.forEach((issue) => expect(issue.body).toBe('the auth refactor'));
  });

  it('preserves counts above five', () => {
    expect(buildInlineIssuesFromPrompt('x', 50)).toHaveLength(50);
  });
});
