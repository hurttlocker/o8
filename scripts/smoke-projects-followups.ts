/**
 * Smoke tests for the #899 dogfood-followup fixes:
 *   1. Shared directive parser includes `projects` in both call sites.
 *   2. Filter membership logic works at the per-directive level.
 *
 * NOT a permanent test harness — there's no test runner configured. This is
 * a one-shot script intended to be run before merging.
 *
 * Usage:
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-projects-followups.ts
 */

import { parseDirectiveFile } from '../src/lib/cortex/directives/parse';
import { directiveAppliesToRepo } from '../src/lib/cortex/directives/filter';

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

// ── Bug 1 — parser parses `projects:` field ───────────────────────────────

console.log('Test: parseDirectiveFile picks up `projects` field');
{
  const raw = `---
id: foo
title: Foo
scope: project
projects: [o8, atlas]
priority: 10
---
This is the body.

## Recent Merges
- 2026-04-29 [merged] feat(thing): bar (#1)
`;
  const parsed = parseDirectiveFile(raw, 'foo');
  assert(parsed !== null, 'parser returns non-null');
  assert(parsed?.id === 'foo', 'id matches');
  assert(parsed?.scope === 'project', 'scope matches');
  assert(JSON.stringify(parsed?.projects) === JSON.stringify(['o8', 'atlas']), `projects=${JSON.stringify(parsed?.projects)}`);
  assert(parsed?.body === 'This is the body.', `body has Recent Merges trailer stripped (got ${JSON.stringify(parsed?.body)})`);
  assert(parsed?.priority === 10, 'priority parsed');
}

console.log('Test: parseDirectiveFile handles bare comma-list shape');
{
  const raw = `---
id: bar
title: Bar
scope: project
projects: o8, atlas, beacon
---
body
`;
  const parsed = parseDirectiveFile(raw, 'bar');
  assert(JSON.stringify(parsed?.projects) === JSON.stringify(['o8', 'atlas', 'beacon']), `projects=${JSON.stringify(parsed?.projects)}`);
}

console.log('Test: parseDirectiveFile defaults to empty projects when missing');
{
  const raw = `---
id: baz
title: Baz
scope: global
---
body
`;
  const parsed = parseDirectiveFile(raw, 'baz');
  assert(parsed?.projects.length === 0, 'projects array is empty');
}

// ── Bug 1 — filter logic is symmetric ─────────────────────────────────────

console.log('Test: directiveAppliesToRepo — global tier always applies');
{
  const directive = parseDirectiveFile(`---
id: g
title: G
scope: global
---
body
`, 'g');
  assert(directiveAppliesToRepo(directive!, '/tmp/repo-foo', new Set()), 'global passes for empty project set');
}

console.log('Test: directiveAppliesToRepo — project tier requires membership');
{
  const directive = parseDirectiveFile(`---
id: p
title: P
scope: project
projects: [o8]
---
body
`, 'p');
  assert(!directiveAppliesToRepo(directive!, '/tmp/repo-foo', new Set()), 'project rejects when repo not in any project');
  assert(!directiveAppliesToRepo(directive!, '/tmp/repo-foo', new Set(['atlas'])), 'project rejects when repo in different project');
  assert(directiveAppliesToRepo(directive!, '/tmp/repo-foo', new Set(['o8'])), 'project accepts when repo in matching project');
}

console.log('Test: directiveAppliesToRepo — repo tier matches by basename or repoName');
{
  const byScope = parseDirectiveFile(`---
id: r1
title: R1
scope: my-repo
---
body
`, 'r1');
  assert(directiveAppliesToRepo(byScope!, '/tmp/my-repo', new Set()), 'scope literal matches basename');
  assert(!directiveAppliesToRepo(byScope!, '/tmp/other-repo', new Set()), 'scope literal does not match different basename');

  const byRepoName = parseDirectiveFile(`---
id: r2
title: R2
scope: repo
repoName: my-repo
---
body
`, 'r2');
  assert(directiveAppliesToRepo(byRepoName!, '/tmp/my-repo', new Set()), 'repoName field matches basename');
  assert(!directiveAppliesToRepo(byRepoName!, '/tmp/other', new Set()), 'repoName field does not match different basename');
}

console.log('');
if (failed > 0) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('All smoke tests passed');
