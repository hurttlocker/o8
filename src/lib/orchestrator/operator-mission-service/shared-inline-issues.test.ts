import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInlineIssue, nextInlineIssueNumbers } from './shared';

function expectInlineIssueNumber(number: number) {
  expect(Number.isSafeInteger(number)).toBe(true);
  expect(isInlineIssue({ number, title: 'inline task', body: '', url: '' })).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('nextInlineIssueNumbers', () => {
  it('allocates unique numbers across same-ms batches', () => {
    vi.useFakeTimers({ now: new Date('2026-07-03T12:00:00.000Z') });

    const first = nextInlineIssueNumbers(25);
    const second = nextInlineIssueNumbers(25);
    const numbers = [...first, ...second];

    expect(new Set(numbers).size).toBe(numbers.length);
    numbers.forEach(expectInlineIssueNumber);
  });

  it('keeps a 1000-iteration allocation loop collision-free', () => {
    const numbers = Array.from({ length: 1000 }, () => nextInlineIssueNumbers(1)[0]!);

    expect(new Set(numbers).size).toBe(numbers.length);
    numbers.forEach(expectInlineIssueNumber);
  });
});
