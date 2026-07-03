import { describe, expect, it } from 'vitest';

import { isInlineIssue, slugify } from './shared';
import {
  buildInlineIssuesFromPrompt,
  clampSpawnCount,
  SPAWN_PROMPT_MAX_AGENTS,
} from './spawn-prompt';

describe('clampSpawnCount', () => {
  it('defaults to 1 and floors fractional counts', () => {
    expect(clampSpawnCount(undefined)).toBe(1);
    expect(clampSpawnCount(Number.NaN)).toBe(1);
    expect(clampSpawnCount(2.9)).toBe(2);
  });

  it('clamps to the [1, MAX] spawn range', () => {
    expect(clampSpawnCount(0)).toBe(1);
    expect(clampSpawnCount(-3)).toBe(1);
    expect(clampSpawnCount(99)).toBe(SPAWN_PROMPT_MAX_AGENTS);
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

    // Every agent shares the body but carries a distinct (i/N) title — the
    // mission layer derives inline/{slug(title)} branches, which must differ.
    const slugs = new Set(issues.map((i) => slugify(i.title)));
    expect(slugs.size).toBe(3);
    issues.forEach((issue) => expect(issue.body).toBe('the auth refactor'));
  });

  it('caps the fleet at SPAWN_PROMPT_MAX_AGENTS', () => {
    expect(buildInlineIssuesFromPrompt('x', 50)).toHaveLength(SPAWN_PROMPT_MAX_AGENTS);
  });
});
