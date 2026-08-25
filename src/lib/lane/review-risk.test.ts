import { describe, expect, it } from 'vitest';

import { extractAddedDiffLines } from './lane-diff-facts';
import { classifyReviewRisk } from './review-risk';

function riskFor(diff: string, changedFiles: string[]) {
  return classifyReviewRisk(changedFiles, extractAddedDiffLines(diff));
}

function diffFor(file: string, added: string[]) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -0,0 +1,3 @@',
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

describe('classifyReviewRisk', () => {
  it('does not treat documentation prose as executable code', () => {
    const file = 'docs/review-system.md';
    const result = riskFor(diffFor(file, [
      'The worker may call setLaneStatus(id, status).',
      'Use UPDATE lanes SET status = completed in this example.',
    ]), [file]);

    expect(result).toEqual({ tier: 'standard', reasons: [], responsibleFiles: [] });
  });

  it('does not promote fenced code examples in Markdown', () => {
    const file = 'docs/examples.md';
    const result = riskFor(diffFor(file, [
      '```ts',
      "setLaneStatus(id, 'completed');",
      '```',
    ]), [file]);

    expect(result.tier).toBe('standard');
  });

  it('promotes the same symbol in executable code with a precise source location', () => {
    const file = 'src/lib/example.ts';
    const result = riskFor(diffFor(file, ["setLaneStatus(id, 'completed');"]), [file]);

    expect(result.tier).toBe('high');
    expect(result.reasons).toContain('code-symbol: lane status transition site: src/lib/example.ts:1');
    expect(result.responsibleFiles).toEqual([file]);
  });

  it('attributes mixed documentation and executable changes only to executable files', () => {
    const docs = diffFor('docs/state-machine.md', ["setLaneStatus(id, 'completed');"]);
    const code = diffFor('src/lib/lane/commands.ts', ["setLaneStatus(id, 'completed');"]);
    const result = riskFor(`${docs}\n${code}`, ['docs/state-machine.md', 'src/lib/lane/commands.ts']);

    expect(result.tier).toBe('high');
    expect(result.responsibleFiles).toEqual(['src/lib/lane/commands.ts']);
    expect(result.reasons.every((reason) => !reason.includes('docs/state-machine.md'))).toBe(true);
  });

  it('does not promote a documentation path merely because its name mentions database work', () => {
    const file = 'docs/db/migration-notes.md';
    const result = riskFor(diffFor(file, ['Historical migration notes.']), [file]);

    expect(result.tier).toBe('standard');
  });
});
