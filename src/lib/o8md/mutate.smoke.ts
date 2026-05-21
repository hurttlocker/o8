/*
 * Smoke for the o8.md mutation companions (src/lib/o8md/mutate.ts).
 * Round-trips appendComment output through the REAL vendored parser — if the
 * emitted wire format ever drifts, extract/validate here fail loudly.
 *
 *   npx tsx src/lib/o8md/mutate.smoke.ts
 */

import assert from 'node:assert/strict';
import { appendComment } from './mutate';
import { extractRoughdraftReviewIndex, validateRoughdraftMarkdown } from './rfm';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

check('standalone comment parses back as an AI comment', () => {
  const md = '# Plan\n\nShip the review engine this week.\n';
  const out = appendComment(md, { body: 'Nice — this is shaping up.' });
  // operator prose untouched
  assert.ok(out.startsWith(md));
  const index = extractRoughdraftReviewIndex(out);
  assert.equal(index.summary.comments, 1);
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].kind, 'comment');
  assert.equal(index.items[0].author, 'AI');
  assert.equal(index.items[0].text, 'Nice — this is shaping up.');
  assert.equal(validateRoughdraftMarkdown(out).ok, true);
});

check('anchored comment wraps the anchor + sets anchorText', () => {
  const md = 'Ship the review engine this week.\n';
  const out = appendComment(md, { body: 'Is this the right name?', anchor: 'review engine' });
  const index = extractRoughdraftReviewIndex(out);
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].anchorText, 'review engine');
  assert.equal(index.items[0].text, 'Is this the right name?');
  assert.equal(validateRoughdraftMarkdown(out).ok, true);
});

check('ids increment off existing items', () => {
  let md = 'Base prose.\n';
  md = appendComment(md, { body: 'first' });
  md = appendComment(md, { body: 'second' });
  const ids = extractRoughdraftReviewIndex(md).items.map((i) => i.id);
  assert.deepEqual(ids, ['c1', 'c2']);
});

check('rejects body with a close delimiter', () => {
  assert.throws(
    () => appendComment('x\n', { body: 'breaks <<} the thread' }),
    /CriticMarkup close delimiter/,
  );
});

check('throws when anchor not found', () => {
  assert.throws(() => appendComment('hello\n', { body: 'note', anchor: 'nope' }), /Anchor text not found/);
});

console.log(`\nmutate smoke: ${passed} checks passed.`);
