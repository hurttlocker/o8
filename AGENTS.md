# Repository Guidelines

## Project Structure & Module Organization
`src/app` contains the Next.js App Router pages and API routes. `src/components` holds UI surfaces, with major splits for `desktop`, `mobile`, and `landing`. Shared logic lives in `src/lib` by domain (`runtime`, `worktree`, `openclaw`, `cortex`, `review`, etc.). `src/ws-server.ts` runs the standalone WebSocket bridge used by the mobile shell. Native desktop packaging lives in `src-tauri`. Product notes, specs, and architecture docs live in `docs`; static assets are in `public` and `assets`.

## Brand Direction
Read [`BRAND.md`](./BRAND.md) before making desktop or mobile visual changes. It defines the current product theme, spacing, color, motion, and component language.

## Build, Test, and Development Commands
Use `npm install` to sync dependencies.

- `npm run dev`: starts Next.js on `http://localhost:3001`
- `npm run dev:ws`: starts the WebSocket server on port `3002`
- `npm run desktop:dev`: runs the web app and WS server together for normal UI work
- `npm run build`: creates the production Next.js build
- `npm run start`: serves the production build on port `3001`
- `npm run lint`: runs ESLint across the repo
- `npm run typecheck`: runs strict TypeScript checks with `tsc --noEmit`
- `npm run tauri:dev` / `npm run tauri:build`: run or package the native Tauri shell

## Coding Style & Naming Conventions
This repo uses TypeScript in `strict` mode and the Next.js ESLint flat config in [`eslint.config.mjs`](./eslint.config.mjs). Match the existing style: 2-space indentation, single quotes, semicolons, and concise comments only where the flow is not obvious. Use `PascalCase` for React components (`DesktopChat.tsx`), `camelCase` for functions and utilities, and keep domain files grouped under `src/lib/<domain>`. Prefer the `@/` path alias over long relative imports.

## Testing Guidelines
No automated test runner is configured yet. For every change, run `npm run lint` and `npm run typecheck`, then smoke-test the affected routes, especially `/`, `/dashboard`, `/landing`, and `/mobile` when UI behavior changes. Validate API and WS changes with the local bridge running via `npm run desktop:dev` or `npm run dev:ws`.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:` and `fix:`. Keep commits focused and imperative, for example `fix: prevent stale mobile transcript replay`. PRs should include a short problem/solution summary, linked issue or design doc when relevant, and manual verification steps. Include screenshots or recordings for desktop/mobile UI changes and note any required env vars in `.env.local` such as `WS_TOKEN`, `GEMINI_API_KEY`, or `VERCEL_TOKEN`.

## o8 CLI (available inside packet worktrees)

When you're an agent dispatched into an o8 packet worktree, the `o8` CLI is on `$PATH` (symlinked to `/usr/local/bin/o8` once o8.app has run at least once; if exit 127 the symlink is missing — re-launch o8.app once to restore it). Use it instead of curling the local HTTP API — it knows your packet context and resolves cwd automatically.

```
o8 status                              # global fleet snapshot (running packets, lanes, merges, approvals)
o8 version                             # CLI + connected server version
o8 doctor [--reap]                     # verify port/token resolution + ping; --reap clears zombie lanes

# Run a long process the operator can WATCH LIVE (servers, backtests, scripts)
o8 run <cmd...>                        # run inside an o8-owned terminal; streams output to you AND lets the operator attach a live view
o8 run --detach <cmd...>               # fire-and-register (servers): returns immediately, leaves it running
o8 run --list                          # list managed runs (running + recent, with exit codes)
o8 run -- <cmd...>                     # put -- before the command when it has its own flags (e.g. o8 run -- pytest -q)

# Packet (your dispatched work) — most auto-resolve the lane from cwd
o8 packet info                         # current packet metadata (id, branch, base, runtime, recent events)
o8 packet scope [packet-id]            # one-call worker context: file ceiling, allowed/blocked paths, directives, related-packet overlap (auto-resolves from cwd)
o8 packet diff [id]                    # this packet's code diff vs base (committed + uncommitted), byte-bounded
o8 packet commit -m "<message>"        # stage + commit the worktree with an explicit pathspec (use instead of raw git add/commit)
o8 packet heartbeat                    # lifecycle ping; safe no-op outside a packet
o8 packet report --event progress [--reason "..." --message "..."]   # surface a structured progress/blocker event
o8 packet capture --url <url> --before|--after [--clip <sel>] [--full-page] [--wait-for <sel>] [--hover <sel>] [--click <sel>] [--settle <ms>] [--label "..."]   # screenshot the running app as VISUAL PROOF of a bug/fix
o8 packet mirror-proof --pr <n> [--repo owner/repo] [--packet <id>]  # mirror the packet's before/after proof onto a GitHub PR (release-asset hosted, zero git bloat)
o8 packet log [id] [--follow] [--since <cursor>]                     # read or tail this packet's lane events
o8 packet runtime-drift                # detect + warn when the lane's bound runtime drifted (exit 5 on drift)
o8 packet review --approve [--commit-message "..."]                  # approve + merge a reviewed packet

# Task pool (project-backed work queue)
o8 task list [--include-done] [--include-brief] [--project <id>] [--repo <path>]   # pool grouped ready/running/review/blocked/done
o8 task create --title "..." [--summary "..." --project <id> --repo <path>]        # add a task to the ready pool
o8 task brief <id>                     # full project-backed brief for one task
o8 task claim <id>                     # bind/reserve a task to a lane
o8 task dispatch <id>                  # launch the claimed task (Codex-only routing)
o8 task block <id> --reason "..."      # mark a task blocked
o8 task report <id> --event "..."      # append a task progress event
o8 task archive <id>                   # prune/archive a stale task row
o8 task prune <id>                     # permanently remove a done/archived task row

o8 lane touches --path <file>          # other lanes touching the same file (or --packet <id>)

# Engineering Brain — ASK it instead of grepping for conventions, history, or ownership.
# Returns an answer + titled citations in seconds; auto-scopes to your packet's repo from cwd.
o8 ask "<question>" [--repo <path>]    # e.g. o8 ask "What is the theming rule for surface colors?"

# Brain feedback — workers contribute observations the orchestrator promotes to directives.
# See "Contributing to the brain" below; this is the only way a worker writes to memory.
o8 cortex observe --kind <regression|pattern|gotcha|preference> --text "..." [--scope packet|repo|global]

# o8.md review surface — the operator authors o8.md; you ANNOTATE it (never overwrite).
o8 spec read     [--repo <path>]       # raw o8.md content
o8 spec index    [--repo <path>]       # structured review threads + summary
o8 spec pending  [--repo <path>]       # only the UNRESOLVED threads (what to address)
o8 spec check    [--repo <path>]       # validate the review markup
o8 spec comment  --repo <path> --body "<thought>" [--anchor "<snippet>"]   # leave a new pointer (author defaults to AI)
o8 spec reply    --repo <path> --to <id> --body "<msg>"                    # reply to a thread
o8 spec resolve  --repo <path> --id <id> [--summary "<note>"]              # mark a thread resolved
o8 spec suggest  --repo <path> --kind add|del|sub --anchor "<text>" [--text "<add>"] [--new "<replacement>"]  # propose a non-destructive edit
```

Output is JSON by default (pass `--human` for pretty ANSI). Errors come back as JSON with a stable schema + an exit code (1 invalid args, 2 connection refused, 3 unauthorized, 4 not found, 5 conflict). Calls are gated by the loopback + ws-token guard that protects the o8 API — they only work locally, no auth needed.

If a command exits 127 (`command not found`), o8.app probably hasn't run yet on this machine, or the symlink was removed; fall back to typecheck + commit and the heal-bot will pick up signals from there.

## Running things the operator can see (`o8 run`)

When you start a process the operator might want to watch — a dev server, a backtest, a long test suite, a build — run it through `o8 run` instead of bare-exec'ing it. `o8 run` owns the process's terminal (a real PTY in an o8 session), so its raw stdout streams back to you exactly as if you'd run it directly **and** the operator can pop open a live, read-only view of it from the o8 ports menu (Agent bucket). A bare-exec'd child's output can't be tapped after the fact, so this is the only way the operator gets to see it.

- Finite jobs (backtests, test runs): `o8 run -- pytest -q` — it streams output and blocks until the command exits, propagating the exit code.
- Servers / daemons you want to leave running: `o8 run --detach -- npm run dev` — returns immediately; the operator attaches whenever.
- It's opt-in: only reach for it when live visibility helps. Quick one-shots don't need it.

## Visual proof for UI changes (`o8 packet capture`)

If your change is **visual** (a UI bug or fix the operator could *see*), capture before/after screenshots so they can recognize the fix at a glance instead of reading your description. The operator sees them as a Bug → Fixed strip on the packet, in review, and in chat.

- **When it applies:** only when you actually have the app's UI running — e.g. the task is a standalone web app you can serve, or you started its server via `o8 run --detach -- <start cmd>`. **Respect the sandbox UI-verification guidance above** — do NOT spin up o8's own Next/Tauri dev servers just to capture; for o8-self UI packets the operator verifies visually and the orchestrator captures during review.
- **The pattern:** capture the broken state first, fix it, capture the fixed state:
  ```
  o8 packet capture --url http://localhost:3000/login --before --label "login button overlaps form" --wait-for "[data-testid=login-form]"
  # ...make the fix...
  o8 packet capture --url http://localhost:3000/login --after  --label "login button overlaps form" --wait-for "[data-testid=login-form]"
  ```
  Use the SAME `--label` on both so they pair into one Bug/Fixed card. `--wait-for <selector>` polls until the real UI is on screen (no blank-loading captures); `--settle <ms>` adds a pause for animations.
- **Frame the actual change — the preview should BE the change:**
  - For a **localized change** (a footer, a button, a card), pass `--clip "<selector>"` — it screenshots just that element's box, so the before/after shows the change tight, not a full page where it's a thin strip. This is the preferred default for most UI fixes.
  - For a **whole-page / layout** change, pass `--full-page` instead (a viewport-only shot lands on the hero and misses below-the-fold changes). `--wait-for "<selector>"` also scrolls that element into view.
  - If the change is an **interaction state** (`:hover`, `:focus`, an open menu, a clicked tab), a static shot shows nothing — pass `--hover "<selector>"` or `--click "<selector>"` to trigger the state before the shot (combine with `--clip` to frame it).
- **Skip it** for pure-logic/backend changes — there's nothing to show, and that's fine (a "no visual proof — backend change" note is the honest default).
- **Mirror it onto the PR (`o8 packet mirror-proof`):** if the packet's work lands as a GitHub PR, run `o8 packet mirror-proof --pr <n>` to surface the same before/after stills as an inline-image comment on the PR, where human reviewers see them. The bytes are hosted on a hidden per-PR prerelease so nothing bloats git history; re-running edits the comment in place. Invoke it once a PR exists (o8 packets usually side-merge, so there's no automatic PR moment).

## Asking the brain (`o8 ask`)

The Engineering Brain answers plain-English questions about the repo from organizational memory — directives, session outcomes, PRs, the symbol graph — with cited, titled sources. One ask costs seconds and saves you a context-burning search. Whether your dispatch *teaches* you about it is governed by the operator's "Workers use the Brain" setting (auto = on for non-frontier models), but the command works in any worktree regardless.

- Good asks: conventions (*"Which middleware gate covers new API routes?"*), history (*"Have we fixed a flaky lane reconciliation before?"*), ownership (*"Who owns the review surface?"*).
- Output: JSON `{ answer, citations: [{kind, title}], sourcesConsidered, cacheHit }`. Name the source when you act on an answer (e.g. "per the CLAUDE.md critical-rules directive").
- Your ask is recorded as a `brain_consulted` lane event — the operator sees what you looked up, with the same titled sources.
- The Brain answers questions; it does not write code. Verify load-bearing answers against the actual file before depending on them.

## Contributing to the brain (`o8 cortex observe`)

When you notice something the operator should remember across dispatches, emit an observation. The o8 auto-directive proposer (#746) picks observations off the queue, surfaces them as a yellow "Proposed directive" row in the O8 Activity tab, and the operator's Accept click writes them as a real directive — which then lands in every future packet's `<context>` envelope. **This is how a worker contributes to the brain.** Each kind has a specific intent:

- `--kind gotcha` — something that bit you that should bite no one again. *"Worktree dirty after `git worktree remove`; check `.git/worktrees/*` metadata before re-creating the lane."*
- `--kind pattern` — a coding rule the operator should enforce. *"Tauri webview rejects `@phosphor-icons/react`; use raw SVG path data from `@phosphor-icons/react/dist/defs/` instead."*
- `--kind regression` — a measurable degradation you found. *"`/api/panel/repos` jumped 8 → 60 ms after the projects-ledger migration."*
- `--kind preference` — a stylistic / workflow choice the operator stated. *"This operator prefers `paddingTop/paddingLeft` longhand to `padding: '12px 14px'` shorthand (React 19 warns on the mix)."*

`--scope packet` (default) means "this is specific to this packet's domain"; `--scope repo` is "all packets in this repo should remember this"; `--scope global` is "every dispatch across every repo should remember this." When in doubt, use `repo`.

The CLI auto-detects your packet from the worktree path — no need to pass `--packet-id` from inside `.cortex-worktrees/packet-*`. If the orchestrator dispatched you to a non-packet path, pass `--packet-id` explicitly.

**Use this whenever:** post-completion you'd write a "by the way" note to the operator. The proposer will surface it. The operator will Accept or Dismiss. Either way, the brain learns and the next agent doesn't have to rediscover what you found.
