# AGENTS.md — the o8 agent protocol

You are working in the o8 repository, usually inside an isolated worktree dispatched by the o8 governance layer. This file is a contract, not a tour: every rule here has a real failure behind it. It is read by every runtime (Codex, Claude Code, Gemini, Cursor, opencode, and others) — assume nothing about your harness beyond a shell.

Claude Code also reads `CLAUDE.md` (architecture + repo rules in depth). Any UI work additionally requires `DESIGN.md`, `hurttlocker.md`, and `STYLEGUIDE.md` — read them before styling anything.

## 1. Verification — what "done" means

```bash
npx tsc --noEmit      # must be clean
npm test              # must be green (vitest)
cargo test --lib      # only if you touched src-tauri/ (run from src-tauri/)
```

**Done =** (a) your change is exercised through its **real entry point** by a test that fails on the pre-change code, (b) typecheck clean, (c) suite green, (d) no unrelated files in the diff, (e) the command output pasted in your report. "Looks correct" is not a completion signal.

Conditional checks — run the extra step when the condition applies:
- **Touched `src/app/api/**/route.ts`** → add the middleware policy entry and cases in `tests/middleware-gate.test.ts`; `tests/route-coverage.test.ts` fails on unclassified routes by design.
- **Touched `src/lib/db/schema.ts`** → follow the migration pattern in `src/lib/db/` (markers at `~/.o8/.db-migrated-v*`).
- **Adding a runtime adapter** → the 6-file recipe in `docs/runtime-adapter-contract.md`, nothing less.
- **Any visible UI change** → screenshot proof in both light and dark palettes.

**Reachability rule:** green tests on a helper prove the mechanism exists, not that anyone reaches it. Drive the actual route handler / dispatch chain / prompt assembler and assert the observable effect. If your test also passes on the pre-change code, it proves nothing.

Environment gotchas that earn their lines:
- **Node 22 required** (`nvm use`) — better-sqlite3 is ABI-pinned; the wrong Node fails natively and confusingly.
- Smoke-test with `tsx <script>`, never `tsx -e "import(...)"` — the latter silently loses named exports.
- Never hardcode ports 3001/3002 — resolve via `getApiBase()` (`@/lib/panel/api-port`).

## 2. Scope — what you own and what you never touch

- You own **your worktree only**. Never edit outside it. Never touch `main` or another agent's worktree.
- Never read, copy, or commit: `.env*`, `~/.o8/ws-token`, `.tmp-owned-push-*/` (contains a live worker token — the merge gate rejects any diff carrying it).
- Never run `git reset --hard`, `git checkout -- <file>` on work you did not author, or any force-push. If the worktree is dirty with someone else's changes, work around them and say so in your report.
- Commit with **explicit pathspecs** — never bare `git add -A` or `git add .`.
- Never render placeholder, mock, or hardcoded data on a user-facing surface. Wire the real path, or state plainly that it isn't wired yet.
- **800-line file ceiling** — decompose before you cross it (layout orchestrators and `ws-server.ts` are waived).

## 3. Blocked — the escalation protocol

- Hard bound: **3 attempts** at any one obstacle, then stop, revert your partial change, and report.
- Forbidden "make it green" moves: skipping or deleting a test, loosening an assertion, widening a type, `@ts-ignore`, disabling a lint rule, catching-and-swallowing an error. A gate you defeated is a bug you shipped.
- The one escalation channel, identical for every runtime:

```bash
o8 packet report --event blocked --message "what you tried; what you need"
o8 packet report --event progress --message "milestone"    # long tasks, at milestones
o8 packet heartbeat                                        # long silent stretches
```

- If the task has more than one reasonable interpretation, ask **before** writing code (report the question through the same channel). Asking costs a turn; the wrong diff costs a re-dispatch.

## 4. Tools — one way per job

- Search: `rg`. GitHub: `gh`. Fleet/packet state: the `o8` CLI (`o8 packet info`, `o8 packet scope`, `o8 lane touches`) — never raw runtime CLIs for fleet state.
- Repo questions: `o8 ask "<question>"` returns cited answers from this repo's own docs and history — far cheaper than a codebase sweep, and every ask is auditable by the operator.
- Assume nothing about your harness: no plan mode, no todo tool, no subagent spawner, no sandbox guarantees. If a step can't be expressed as a shell command, don't build your plan on it.

## 5. Handoff — the report contract

Your final report, every time, in this shape:

1. **What changed** — one paragraph, plain language.
2. **Files touched** — as `path/to/file:line` references.
3. **Commands run + their actual output** — the verification evidence from §1.
4. **What you did NOT do** — descoped items, known gaps, anything you worked around.
5. **Residual risk** — what a reviewer should look at hardest.

Commit discipline: prefix `feat:|fix:|refactor:|perf:|chore:`, one logical change per commit, explicit pathspecs. Don't open reports with filler; don't end a completion with a question.

## UI work (summary — the spec files govern)

Inline styles only (no CSS classes — permanent, iOS Safari reliability). Theme tokens (`var(--t-*)`), never hardcoded rgba on themed surfaces. No emoji — raw SVG icons matching whichever library the surrounding surface uses. 44px touch targets. No Material Design patterns; no "..." overflow menus. When in doubt, `hurttlocker.md` is the locked spec.

## Why this file looks like this

The root stays short on purpose: agents pay for every line on every turn, and long files get ignored precisely where they matter. Rules live here only when they encode something you cannot derive from the code — commands, prohibitions, and contracts, each with a failure behind it. When a rule keeps getting violated anyway, it graduates to a CI gate or hook instead of more prose. Deeper, directory-specific instructions live in nested `AGENTS.md` files next to the code they govern.
