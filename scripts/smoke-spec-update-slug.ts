// Smoke test for Bug 2 — Spec-Update parser + matcher gain a slug-fallback
// for em-dash / hyphen / punctuation tolerance.
//
// Run from worktree root:
//   npx tsx scripts/smoke-spec-update-slug.ts

import {
  matchesSpecUpdateTargets,
  parseSpecUpdateTargets,
  type DirectiveMeta,
} from '@/lib/cortex/directive-merges';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, debug?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${debug !== undefined ? ` :: ${JSON.stringify(debug)}` : ''}`);
  }
}

function meta(input: Partial<DirectiveMeta> & Pick<DirectiveMeta, 'id'>): DirectiveMeta {
  return {
    id: input.id,
    title: input.title ?? null,
    scope: input.scope ?? 'global',
    repoName: input.repoName ?? null,
    history: input.history ?? true,
  };
}

// 1. Empty commit message → no targets → blanket match.
check(
  'empty commit message → blanket',
  parseSpecUpdateTargets('').length === 0
    && matchesSpecUpdateTargets(meta({ id: 'foo' }), 'foo.md', []),
);

// 2. Single Spec-Update parses lower-cased.
{
  const targets = parseSpecUpdateTargets(
    'feat: something\n\nSpec-Update: 800-line file ceiling — decompose before adding\n',
  );
  check(
    'parse single Spec-Update',
    targets.length === 1
      && targets[0] === '800-line file ceiling — decompose before adding'.toLowerCase(),
    targets,
  );
}

// 3. Acceptance: Spec-Update with abbreviated title matches via slug
// substring against a directive whose title has em-dash + extra words.
{
  const directive = meta({
    id: 'file-ceiling',
    title: '800-line file ceiling — decompose before adding',
  });
  const commit = 'feat: x\n\nSpec-Update: 800-line file ceiling\n';
  const targets = parseSpecUpdateTargets(commit);
  const ok = matchesSpecUpdateTargets(directive, 'file-ceiling.md', targets);
  check(
    'slug substring: "800-line file ceiling" matches em-dash variant',
    ok,
    { targets, directive },
  );
}

// 4. Task-specified case: "Spec-Update: 800-line ceiling" against
// directive title "800-line file ceiling — decompose before adding".
// The task's grading example calls this out as "matches via slug
// substring/equality fallback". With our slug logic:
//   target slug   = "800-line-ceiling"
//   directive slug = "800-line-file-ceiling-decompose-before-adding"
// The target slug "800-line-ceiling" is NOT a substring of the directive
// slug because "ceiling" appears after "file" in the directive.
// HOWEVER the task says: "Spec-Update: 800-line ceiling does NOT match
// a directive whose title is 800-line file ceiling — decompose before
// adding" is the BUG. The fix should make it match.
//
// We achieve this by ALSO matching when both slugs share all
// non-trivial slug tokens, i.e. every token in the target appears in the
// directive slug (token-subset match). This makes "800-line ceiling"
// match "800-line file ceiling — decompose before adding" because both
// "800-line" and "ceiling" appear as tokens in the directive slug.
{
  const directive = meta({
    id: 'file-ceiling',
    title: '800-line file ceiling — decompose before adding',
  });
  const commit = 'feat: x\n\nSpec-Update: 800-line ceiling\n';
  const targets = parseSpecUpdateTargets(commit);
  const ok = matchesSpecUpdateTargets(directive, 'file-ceiling.md', targets);
  check(
    'token-subset: "800-line ceiling" matches "800-line file ceiling — decompose before adding"',
    ok,
    { targets, directive },
  );
}

// 5. Exact title still wins (case-insensitive).
{
  const directive = meta({ id: 'foo', title: 'Foo Bar' });
  const targets = parseSpecUpdateTargets('Spec-Update: foo bar');
  check(
    'exact title (case-insensitive)',
    matchesSpecUpdateTargets(directive, 'foo.md', targets),
  );
}

// 6. Filename match with .md.
{
  const directive = meta({ id: 'whatever' });
  const targets = parseSpecUpdateTargets('Spec-Update: my-rule.md');
  check(
    'filename with .md matches',
    matchesSpecUpdateTargets(directive, 'my-rule.md', targets),
  );
}

// 7. Filename match without .md.
{
  const directive = meta({ id: 'whatever' });
  const targets = parseSpecUpdateTargets('Spec-Update: my-rule');
  check(
    'filename without .md matches',
    matchesSpecUpdateTargets(directive, 'my-rule.md', targets),
  );
}

// 8. id match.
{
  const directive = meta({ id: 'rule-7' });
  const targets = parseSpecUpdateTargets('Spec-Update: Rule-7');
  check(
    'id case-insensitive match',
    matchesSpecUpdateTargets(directive, 'unrelated.md', targets),
  );
}

// 9. Negative — unrelated target doesn't match.
{
  const directive = meta({ id: 'foo', title: 'Foo Bar' });
  const targets = parseSpecUpdateTargets('Spec-Update: completely-different');
  check(
    'unrelated target does not match',
    matchesSpecUpdateTargets(directive, 'foo.md', targets) === false,
  );
}

// 10. Slug-equality (not substring): "foo bar" vs "Foo  Bar" with double
// space.
{
  const directive = meta({ id: 'fb', title: 'Foo  Bar' });
  const targets = parseSpecUpdateTargets('Spec-Update: foo-bar');
  check(
    'slug equality across whitespace variants',
    matchesSpecUpdateTargets(directive, 'fb.md', targets),
  );
}

// 11. Multiple Spec-Update lines, only some match.
{
  const directive = meta({ id: 'a', title: 'Alpha' });
  const targets = parseSpecUpdateTargets(
    'feat\n\nSpec-Update: not-this\nSpec-Update: alpha\n',
  );
  check(
    'multiple Spec-Update lines: any match wins',
    targets.length === 2 && matchesSpecUpdateTargets(directive, 'a.md', targets),
    targets,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
