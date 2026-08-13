# GEMINI.md

Project memory for Gemini CLI when dispatched by the o8 orchestrator against this repo. Gemini CLI auto-loads this file from the workspace hierarchy (see `~/.gemini/settings.json` `contextFileName`). Keep it focused — context is expensive.

## What this repo is

**o8** — the governance layer for autonomous engineering teams. A Next.js 16 + Tauri v2 desktop app that dispatches coding agents (Codex, Claude Code, Gemini, opencode) against isolated git worktrees, gates merges behind review, and persists organizational memory.

You are running as a **worker** in that pipeline. A Claude orchestrator designed the packet you're executing and will review your diff before it merges to `main`. Stay in your scoped packet; don't refactor outside the stated files.

## Outcome ownership

Translate the packet into an observable desired outcome, separate the reported symptom from established facts and the likely cause, and implement the smallest complete remedy inside the packet boundary. Verify the behavior through its real entry point when available. A clean commit and typecheck mean the work is ready for independent review; they do not by themselves prove the user's outcome is closed.

Address or escalate an adjacent finding only when it blocks the packet or makes it unsafe. Record recurrence-relevant findings proportionately and leave unrelated work alone. End with the packet prompt's Outcome, Evidence, Residual, and Decision fields, without using this doctrine to expand scope or authority.

## Non-negotiables

- **800-line file ceiling.** If your edits would push a file past 800 lines, extract into focused modules first, then edit. Layout orchestrators (`page.tsx`) and multiplexers (`ws-server.ts`) are explicitly waived.
- **Inline styles only.** No CSS classes in React components. Use `style={{ }}` props. This is an iOS Safari reliability requirement, permanent.
- **No CSS shorthand.** Write `paddingTop: 8, paddingLeft: 12` — never `padding: "8px 12px"`. React 19 warns on mixed shorthand/longhand.
- **Never use emojis** in UI, comments, or commit messages. Icons are Phosphor raw SVG.
- **Never hardcode port 3001/3002.** Use `getApiBase()` from `@/lib/panel/api-port` — the Tauri sidecar picks dynamic ports.
- **Never hardcode `/Users/<name>/...` paths.** Use `process.cwd()`, `os.homedir()`, `process.env.HOME`, or an explicit env var.
- **Never hardcode theme colors like `rgba(255,255,255,0.56)`.** Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)` — they adapt across light/midnight themes.
- **Tauri webview cannot render React icon libraries.** No `@phosphor-icons/react`, no `lucide-react`. Extract raw SVG path data.
- **Never use `ai` SDK.** Use `fetch` against `/api/v2/proxy/llm`.
- **Never throw in API routes.** Return structured error responses.
- **Never use native `<select>` or `<input>` inside packet cards.** Mission Control uses clickable row + custom popover.

## Commit discipline

- Message prefix: `feat:` `fix:` `refactor:` `perf:` `chore:` `design:` `docs:`
- Console log prefix: `[feature-name]` (e.g. `[memory-recall]`, `[compaction]`, `[gemini]`)
- Stage only the files your packet was supposed to touch. If a pre-commit hook auto-stages unrelated files (e.g. `.claude/settings.json`), reset the commit, `git reset HEAD <unrelated-file>`, re-stage only your intended diff, and commit again.
- Always end with a `<self-review>` block per the packet prompt. Confidence: `high` only when diff cleanly matches spec.

## Architecture touchpoints (skim before editing)

- **Runtime adapters** live in `src/lib/runtimes/` with shared primitives under `src/lib/runtimes/shared/` (cli-resolver, owned-session-store, turn-dispatcher, cost-parser-registry). Adding a new runtime is a 6-file patch — see `docs/internals/runtime-adapter-contract.md`.
- **Orchestrator types** — `src/lib/orchestrator/types.ts:3` has the canonical `OrchestratorRuntime` union. `src/lib/orchestrator/runtime-capabilities.ts` has the `ORCHESTRATOR_RUNTIMES` map keyed by runtime id. UI reads from the map instead of branching on strings.
- **Desktop UI** lives in `src/components/desktop/`. Mobile UI lives in `src/components/mobile/` and is **completely separate** — no shared components. Don't cross the streams.
- **API security** — `src/middleware.ts` gates dangerous prefixes (`/api/panel/`, `/api/orchestrator/`, `/api/runtime/`, etc.) on loopback origin + ws-token. Never add a new state-mutating route without going through the gate.
- **Database** — SQLite via better-sqlite3 + Drizzle at `~/.cortex-ide/`. Schema at `src/lib/db/schema.ts`. WAL mode, FK on. Schema auto-migrates on boot.

## Paths you will edit often

- `src/lib/orchestrator/` — orchestrator types, capability map, scheduling
- `src/lib/runtimes/` — runtime adapters and shared primitives
- `src/components/desktop/thoughts/` — orchestrator chat + mission control UI
- `src/components/desktop/workspace-terminal/` — CLI tabs + live tail
- `src/components/desktop/repo-registry/` — agent panel + repo rows
- `docs/` — architecture docs; `runtime-adapter-contract.md` is the canonical reference

## Paths you should NEVER edit

- `out/` — build artifacts
- `src-tauri/target/` — Rust build cache
- `node_modules/`
- `.cortex-worktrees/` — isolated worktrees belong to sibling dispatches
- `~/.o8/` — owned-session data outside the repo

## How to verify your diff before committing

```bash
npx tsc --noEmit             # must pass, always — the one blocking gate
npx eslint <changed files>   # advisory, CHANGED FILES ONLY — never repo-wide `npm run lint` (slow; blocks nothing)
git diff main...HEAD         # self-review gate before the <self-review> block
```

Do not block completion waiting on a slow or repo-wide check — finalize the moment typecheck passes and your changed-file checks are clean. o8 runs the authoritative typecheck + change-scoped rule-check at the merge gate.

## When you're blocked

Surface the blocker in your packet output. Don't expand scope. Don't make up a filepath that doesn't exist. Don't disable a test or a type check to make red go green — if typecheck fails, fix the type, don't silence it.

If the packet asked you to edit a file that turns out to violate an invariant in this doc (e.g. would push a file past 800 lines), surface it as a decomposition request instead of doing the edit.
