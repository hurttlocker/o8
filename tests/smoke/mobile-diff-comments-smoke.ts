/**
 * #9 mobile inline diff comments — DB-backed store smoke test.
 * Run: CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *      npx tsx tests/smoke/mobile-diff-comments-smoke.ts
 */

import assert from 'node:assert';

import './require-temp-data-dir';
import {
  createDiffComment,
  listDiffComments,
  countOpenDiffComments,
  resolveDiffComment,
  formatOpenDiffCommentsForPrompt,
} from '@/lib/mobile/diff-comments';

function main(): void {
  const sk = 'codex-owned:abc123';

  // Malformed inputs are rejected.
  assert(createDiffComment({ sessionKey: '', path: 'a.ts', lineNumber: 1, side: 'new', text: 'x' }) === null, 'empty sessionKey → null');
  assert(createDiffComment({ sessionKey: sk, path: 'a.ts', lineNumber: 1, side: 'new', text: '' }) === null, 'empty text → null');
  assert(createDiffComment({ sessionKey: sk, path: 'a.ts', lineNumber: Number.NaN, side: 'new', text: 'x' }) === null, 'NaN line → null');

  const c1 = createDiffComment({ sessionKey: sk, path: 'src/x.ts', lineNumber: 42, side: 'new', text: 'add a guard here' });
  assert(c1 && c1.id && c1.side === 'new' && c1.lineNumber === 42, 'create returns a comment');
  assert(c1!.resolvedAt === null, 'new comment is open');

  const c2 = createDiffComment({ sessionKey: sk, path: 'src/y.ts', lineNumber: 7, side: 'old', text: 'why delete this?' });
  assert(c2 && c2.side === 'old', 'side old round-trips');

  // A comment on a DIFFERENT session is isolated.
  createDiffComment({ sessionKey: 'other', path: 'z.ts', lineNumber: 1, side: 'new', text: 'nope' });

  const list = listDiffComments(sk);
  assert(list.length === 2, 'lists only this session (newest first)');
  assert(list[0].path === 'src/y.ts', 'newest first');
  assert(countOpenDiffComments(sk) === 2, 'two open');

  const prompt = formatOpenDiffCommentsForPrompt(sk);
  assert(prompt.includes('src/x.ts:42 (new): add a guard here'), 'prompt block renders the anchor');
  assert(prompt.indexOf('src/x.ts') < prompt.indexOf('src/y.ts'), 'prompt is oldest-first');

  assert(resolveDiffComment(c1!.id) === true, 'resolve transitions an open comment');
  assert(resolveDiffComment(c1!.id) === false, 'second resolve is a no-op');
  assert(countOpenDiffComments(sk) === 1, 'one open after resolve');
  assert(listDiffComments(sk, { openOnly: true }).length === 1, 'openOnly drops the resolved one');
  assert(listDiffComments(sk).length === 2, 'full list still shows the resolved one');

  console.log('[mobile-diff-comments-smoke] PASS');
}

main();
