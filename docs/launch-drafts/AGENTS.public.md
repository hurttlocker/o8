# AGENTS.md — the o8 agent protocol

You are working in the o8 repository, sometimes inside an isolated worktree dispatched by the o8 governance layer. This file is a contract, not a tour: every rule here has a real failure behind it. It is read by every runtime (Codex, Claude Code, Gemini, Cursor, OpenCode, and others), so assume nothing about your harness beyond a shell.

Claude Code also reads `CLAUDE.md`. UI work additionally requires `DESIGN.md`, `hurttlocker.md`, and `STYLEGUIDE.md`; read them before styling anything.

## 1. Verification — what "done" means

```bash
npx tsc --noEmit                         # must be clean
npm test                                 # must be green
npm run rule-check -- --base=<ref>       # changed TypeScript/TSX
npx eslint <changed-files>               # touched files only
cargo test --lib                         # if src-tauri/ changed; run there
```

**Done =** (a) changed behavior is exercised through its real entry point by a test that fails on the pre-change code, (b) typecheck is clean, (c) the suite is green, (d) the diff contains no unrelated files, and (e) the report includes the actual command results. "Looks correct" is not a completion signal.

Conditional checks:

- **Touched `src/app/api/**/route.ts`** → the route is gated by default and is already walked by `tests/route-coverage.test.ts`. Add a narrow middleware policy and focused `tests/middleware-gate.test.ts` cases only for public, loopback-read, self-authenticating, capability-specific, or deliberately explicit gated access.
- **Touched `src/lib/db/schema.ts`** → follow the creation and migration patterns in `src/lib/db/index.ts` and the versioned migration modules.
- **Adding a runtime** → follow the declarative or specialized path in `docs/runtime-adapter-contract.md`; there is no fixed file-count recipe.
- **Visible UI change with a running surface** → capture the real state with `o8 packet capture --url <url> --before|--after --label "<same label>"`; verify both palettes when the change can affect palette behavior.

**Reachability rule:** green tests on a helper prove the mechanism exists, not that callers reach it. Drive the actual route handler, dispatch chain, prompt assembler, or persisted-state path and assert the observable effect. If the test also passes on the pre-change code, it proves nothing.

Environment gotchas:

- **Node 22 is required** (`nvm use`) because `better-sqlite3` is ABI-sensitive.
- Smoke-test with `tsx <script>`, never `tsx -e "import(...)"`; the latter can silently lose named exports.
- Development defaults to API `47120` and WS `47125`, but never hardcode backend ports. Use `getApiBase()`, `getWsBase()`, or `resolvePortInfo()` from `@/lib/panel/api-port`.

## 2. Scope — what you own and what you never touch

- If `o8 packet info` identifies a packet worktree, stay inside it. Otherwise preserve the current worktree and never edit another worktree.
- Preserve unrelated changes. Never run `git reset --hard`, revert files you cannot prove you own, or force-push.
- Do not read, copy, or commit secret-bearing `.env`, `.env.local`, token files such as `~/.o8/ws-token`, or `.tmp-owned-push-*/`. Do not use a blanket `.env*` rule because tracked example files may be documentation.
- Stage explicit pathspecs; never use bare `git add -A` or `git add .`.
- Never render placeholder, mock, or hardcoded data on a user-facing surface. Wire the real path or state plainly that it is not wired.
- The 800-line ceiling applies except to `src/app/dashboard/page.tsx`, `src/ws-server.ts`, `src/lib/worktree/manager.ts`, and `src/lib/lane/commands.ts`. New waivers require an explicit decision.
- Do not introduce new `className` in TSX, multi-value spacing shorthand, hardcoded rgba-white surfaces, emoji UI, or React icon-library imports under `src/components/desktop/`. `npm run rule-check -- --base=<ref>` enforces these on changed lines.
- Keep hooks unconditional and in stable order; do not put an early `return null` before hooks.
- Ad-hoc LLM calls use the existing proxy/routing layer. `src/lib/chat/gateway-client.ts` is the only sanctioned AI SDK import boundary.

## 3. Blocked — the escalation protocol

- After three failed attempts at the same obstacle, stop and report what you tried, what remains, and any partial state. Do not automatically revert work you cannot prove you own.
- Forbidden "make it green" moves: skipping or deleting a test, loosening an assertion, widening a type, adding `@ts-ignore`, disabling a lint rule, or catching and swallowing an error.
- In a packet worktree, report through the shared control plane:

```bash
o8 packet report --event blocked --message "what you tried; what you need"
o8 packet report --event progress --message "milestone"
o8 packet heartbeat
```

- If `o8` exits 127, launch o8.app once and run `o8 doctor --repair` after the binary is reachable. If the control plane remains unavailable, continue only with work that does not require packet mutation and report that boundary normally.
- If a task has more than one materially different interpretation, ask before writing code. In a packet, report the question through the same channel.

## 4. Tools — one way per job

- Search with `rg`; use `gh` for GitHub.
- Use `o8 packet info`, `o8 packet scope`, and `o8 lane touches` for packet and fleet state; do not substitute raw runtime CLIs.
- Use `o8 ask "<question>"` for cited orientation from repo documentation and history, then verify load-bearing answers against implementation and tests.
- Assume no plan mode, todo tool, subagent spawner, or sandbox guarantees. If a required step cannot be expressed through capabilities every target harness has, do not build the plan around it.

## 5. Handoff — the report contract

Report:

1. **What changed** — one plain-language paragraph.
2. **Files touched** — `path/to/file:line`.
3. **Commands run and actual results** — verification evidence from section 1.
4. **What you did not do** — descoped items, gaps, and workarounds.
5. **Residual risk** — what the reviewer should inspect hardest.

Use `feat:`, `fix:`, `refactor:`, `perf:`, or `chore:` for one logical commit with explicit pathspecs. Do not open with filler or end a completion report with a question.

Root instructions stay short because every agent pays for every line. Directory-specific rules belong in nested `AGENTS.md` files when first-party subtrees need them; until then, the implementation and tests are authoritative.
