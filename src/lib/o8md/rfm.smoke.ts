/*
 * Smoke test for the vendored RFM parser (src/lib/o8md/rfm.ts).
 *
 * o8 has no test runner, so this mirrors the CLAUDE.md "tsx smoke" pattern.
 * It ports the load-bearing assertions from the upstream vitest suite
 * (@roughdraft/rfm index.test.ts) to plain node:assert, proving the
 * vendored copy compiles + behaves byte-identically under o8's toolchain.
 *
 *   npx tsx src/lib/o8md/rfm.smoke.ts
 */

import assert from 'node:assert/strict';
import {
  appendRoughdraftReply,
  extractRoughdraftReviewIndex,
  markRoughdraftResolved,
  validateRoughdraftMarkdown,
} from './rfm';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── validate ───────────────────────────────────────────────────────────────
check('validate accepts comments + suggestions', () => {
  const result = validateRoughdraftMarkdown(
    [
      'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
      'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
      'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
    ].join('\n'),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.comments, 1);
  assert.equal(result.summary.suggestions, 2);
  assert.equal(result.summary.legacyMetadata, 0);
});

check('validate ignores markers inside code fences + inline code', () => {
  const result = validateRoughdraftMarkdown(
    ['```md', 'This is {>>not a comment<<}.', '```', 'Literal `{>>x<<}` text.'].join('\n'),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.comments, 0);
});

check('validate reports missing canonical metadata', () => {
  const codes = validateRoughdraftMarkdown('{>>Needs metadata<<}\n').diagnostics.map((d) => d.code);
  assert.deepEqual(codes, ['missing-metadata-id', 'missing-metadata-by', 'missing-metadata-at']);
});

check('validate flags self-reply error', () => {
  const result = validateRoughdraftMarkdown(
    '{>>Self<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z" re="c1"}\n',
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.map((d) => d.code).includes('self-reply'));
});

// ── extract ──────────────────────────────────────────────────────────────────
check('extract returns items + summary with AI authorship', () => {
  const index = extractRoughdraftReviewIndex(
    [
      'Please revisit {==this sentence==}{>>Needs a source.<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}.',
      '{>>I added one.<<}{id="c2" by="AI" at="2026-04-28T12:02:00.000Z" re="c1"}',
      'Add {++one concrete example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"}.',
      'Use {~~rough~>specific~~}{id="s2" by="user" at="2026-04-28T12:07:00.000Z"} wording.',
    ].join('\n'),
  );
  assert.equal(index.summary.comments, 1);
  assert.equal(index.summary.replies, 1);
  assert.equal(index.summary.suggestions, 2);
  assert.equal(index.summary.unresolved, 4);
  assert.deepEqual(
    index.items.map((i) => [i.id, i.kind]),
    [['c1', 'comment'], ['c2', 'reply'], ['s1', 'suggestion'], ['s2', 'suggestion']],
  );
  // AI vs human authorship is distinguishable (the inversion relies on this)
  assert.equal(index.items[1].author, 'AI');
  assert.equal(index.items[0].author, 'user');
});

// ── mutation (byte-exact splice) ─────────────────────────────────────────────
check('appendReply splices byte-exact, leaves rest untouched', () => {
  const md = '# Plan\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"} as written.\n';
  const out = appendRoughdraftReply(md, {
    parentId: 'c1',
    id: 'c2',
    author: 'AI',
    at: '2026-04-28T12:10:00.000Z',
    message: 'Added a citation in the next paragraph.',
  });
  assert.equal(
    out,
    '# Plan\n\nKeep {==this claim==}{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}{>>Added a citation in the next paragraph.<<}{id="c2" by="AI" at="2026-04-28T12:10:00.000Z" re="c1"} as written.\n',
  );
});

check('appendReply rejects close-delimiter injection', () => {
  const md = '{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
  assert.throws(
    () => appendRoughdraftReply(md, {
      parentId: 'c1',
      id: 'c2',
      author: 'AI',
      at: '2026-04-28T12:10:00.000Z',
      message: 'This closes early <<} and corrupts the thread.',
    }),
    /CriticMarkup close delimiter/,
  );
});

check('markResolved annotates target only, byte-exact', () => {
  const md = 'Add {++one example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z"} and keep {>>open question<<}{id="c1" by="user" at="2026-04-28T12:06:00.000Z"}.\n';
  const out = markRoughdraftResolved(md, { targetId: 's1', summary: 'Accepted in draft.' });
  assert.equal(
    out,
    'Add {++one example++}{id="s1" by="AI" at="2026-04-28T12:05:00.000Z" status="resolved" resolved="Accepted in draft."} and keep {>>open question<<}{id="c1" by="user" at="2026-04-28T12:06:00.000Z"}.\n',
  );
});

console.log(`\nRFM smoke: ${passed} checks passed.`);
