// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { buildPrReviewGuide, readPrGuideProgress } from './review-guide';
import type { PrDetail } from './types';
const detail = { number: 1, headSha: 'a'.repeat(40), files: [], changedFiles: 0, body: '', statusCheckRollup: [] } as unknown as PrDetail;
it('builds a commit-pinned starting order with explicit binary, omitted and unknown coverage', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `docs/${i}.md`, status: 'modified', additions: 1, deletions: 0, patch: '' }));
  files.push({ path: 'src/auth/check.ts', status: 'modified', additions: 2, deletions: 0, patch: '' });
  const guide = buildPrReviewGuide({ ...detail, files, changedFiles: 13, checksUnavailable: true, discussionIncomplete: true })!;
  expect(guide.head).toBe(detail.headSha); expect(guide.steps[1].file).toBe('src/auth/check.ts');
  expect(guide.steps.find(step => step.id === 'remaining-files')?.note).toContain('3 more');
  expect(guide.steps.find(step => step.id === 'checks')?.note).toContain('could not be read');
  expect(guide.steps.at(-1)?.note).toContain('omitted');
  expect(buildPrReviewGuide({ ...detail, files: [{ ...files[0], patch: null }] })?.steps[1].note).toContain('unavailable');
});
it('requires a source commit and restores only valid progress from durable browser storage', () => {
  expect(buildPrReviewGuide({ ...detail, headSha: '' })).toBeNull();
  localStorage.setItem('o8:pr-review-guide:cold-storage', JSON.stringify({ head: 'b'.repeat(40), base: '', done: ['intent'] }));
  expect(readPrGuideProgress('cold-storage')?.done).toEqual(['intent']);
  localStorage.setItem('o8:pr-review-guide:invalid-storage', JSON.stringify({ head: 'wrong', done: [null] }));
  expect(readPrGuideProgress('invalid-storage')).toBeNull();
});
