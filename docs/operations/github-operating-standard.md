# GitHub operating standard

How work moves through this repository. It applies to maintainers and to the agents they run, and it is what a contributor can expect from us.

## Findings become issues

Anything that fails, surprises, or stalls becomes an issue when it is found, not at the end of the session. The title names the mechanic in one line. The body has three sections in order: **Mechanic** (what happens, and where in the code if known), **Expected**, and **Acceptance** (a checkbox list a reviewer can verify). Each issue carries one `pillar/*` label. `claimable` means anyone may take it; `claimed` means someone has, and it expires after seven days with no linked pull request.

Issue text describes mechanics, never sources. No names of people or other products, no logs pasted without a scan for paths, tokens, or machine names. Issue bodies are never edited to remove something after the fact, because the edit history is public.

## Tracking issues own progress

Each open arc on [ROADMAP.md](../../ROADMAP.md) links one tracking issue. A tracking issue has a "Done means" line, a `## Checklist` of child issues, and a "How to help" line. A box is checked only when the child is closed and its fix is in a shipped release. `node scripts/roadmap-status.mjs --check` fails when a checked child is still open, and CI runs it on every push to main. When reality changes, a measurement or a state, the roadmap row changes the same day.

## One pull request per issue

A pull request fixes one issue, from a branch cut from `main`. Its body has the mechanic, what changed, how it was verified with test file names, and `Fixes #n`.

Verification means a test that drives the real entry point: the route handler, the CLI command, the merge path, or persisted state, not the helper in isolation. The test is written first and fails, then the fix makes it pass, and both tails appear in the pull request. `npx tsc --noEmit` and `npm test` run before push. See CLAUDE.md, "Real-path tests", for why.

Documentation uses plain punctuation and states what ships. A claim the roadmap contradicts does not go in.

## Merge discipline

Someone who did not write the change reads the whole diff before it merges. Workers never merge their own work. Merges happen on green checks, squashed, with the branch deleted. Shipping a release is a separate, human decision.

## Other people's repositories

When we contribute elsewhere, we follow that project's contributing guide, pull request template, and proof rules as written, say plainly what we could not do, and never merge on their side.

## Closing the loop

Every session that touches issues or pull requests ends with the roadmap and tracking issues matching reality. Every session starts by answering any issue or pull request whose last comment came from outside the maintainers.
