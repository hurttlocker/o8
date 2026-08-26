# o8 Repository Guide

This is the Codex-facing execution guide for the o8 repository. [`CLAUDE.md`](./CLAUDE.md) carries broader product and architecture context, but volatile inventories in documentation can drift; for ports, scripts, runtime registrations, route policy, and test behavior, the implementation and tests are authoritative.

## What o8 Is

o8 is a Next.js 16 + React 19 application packaged in a Tauri v2 desktop shell. It is the governance and operator-control layer for autonomous engineering: missions, isolated packet worktrees, review and approval gates, audit history, organizational memory, a mobile remote-control surface, and Symon voice control.

The root route redirects to `/dashboard`. Desktop UI lives primarily in `src/app/dashboard` and `src/components/desktop`; mobile is intentionally separate under `src/app/mobile` and `src/components/mobile`. `src/ws-server.ts` is the standalone realtime bridge. Native packaging and Symon live in `src-tauri`.

Keep two extension systems distinct:

- **Orchestrator backends** live in `src/lib/lane/orchestrator-backends/`. They decide which system drives an orchestration turn.
- **Worker/runtime adapters** live in `src/lib/runtimes/`. The UI and API use the runtime registry and capability contract rather than talking directly to Codex, Claude Code, Gemini, OpenCode, Cursor, Grok, Pi, or cloud workers.

Do not assume that the active orchestrator backend and a dispatched worker runtime are the same. The `auto` backend currently resolves through `active-backend.ts`; inspect that resolver and the registries before changing routing behavior.

## Outcome Ownership

- Translate the request into an observable desired outcome before acting. Treat the reported problem as a signal, then separate symptoms, established facts, hypotheses, and root cause.
- Choose the smallest complete remedy allowed by the task scope, work mode, and your authority. Read-only and diagnostic requests remain non-mutating; their complete outcome is an evidence-backed finding, decision, or handoff.
- Classify adjacent findings instead of ignoring or absorbing them: address or escalate anything that blocks the outcome or makes it unsafe, fix or record recurrence-relevant pain proportionately, and leave unrelated work alone.
- Verify through the real entry point at a level proportionate to risk. A plan, issue, commit, test, or merge is evidence, not automatically closure.
- When blocked, preserve state and report the exact blocker, evidence, and shortest safe unblock. Add proportionate recurrence protection when useful, preferring a test, invariant, validation, automation, or Cortex observation over a warning future agents can miss.
- Report Outcome, Evidence, Residual, and Decision. Never represent partial or uncertain work as complete, and never treat these rules as permission to exceed approval, safety, public-action, production, or packet boundaries.

## Repository Map

- `src/app`: Next.js App Router pages and API routes.
- `src/components`: desktop, mobile, and shared UI surfaces.
- `src/lib`: domain logic; the largest active areas are lane/orchestration, runtimes, Cortex/Brain, MCP, mobile, auth, worktrees, DB, browser, and operator settings.
- `src/ws-server.ts` and `src/lib/ws-server`: WebSocket transport and extracted server domains.
- `src-tauri`: Rust shell, native commands, packaging, updater, and Symon.
- `cli`: source for the `o8` CLI. Treat `cli/src/index.ts` and command implementations as the command-surface truth.
- `tests` plus colocated `src/**/*.test.ts`: Vitest coverage, including route/auth/reachability tests.
- `scripts`: build, release, smoke, benchmark, and rule-check tooling.
- `docs`: architecture, product, security, performance, and handoff material.

Local state is SQLite/file-backed under `~/.o8` by default. Use `CORTEX_IDE_DATA_DIR` for isolated tests or alternate state; do not write tools that assume one developer's home path.

## Design Sources

For desktop or mobile visual work, read these in order:

1. [`hurttlocker.md`](./hurttlocker.md) for operator-locked typography, icon, row, and layout geometry.
2. [`DESIGN.md`](./DESIGN.md) for the desktop visual language, palette, surfaces, and accessibility model.
3. [`STYLEGUIDE.md`](./STYLEGUIDE.md) for interaction review gates: feedback timing, sibling cohesion, and button hierarchy.
4. `src/lib/theme/` for the actual light/dark × glass/solid token implementation.

`BRAND.md` is historical Cortex-era direction and is not the current implementation authority.

## Setup and Commands

Use Node 22 (`package.json` pins `>=22 <23`) and `npm install` to sync dependencies.

- `npm run dev`: starts the coordinated Next + WebSocket development stack and cleans its registered stale processes first. The current defaults are API `47120` and WS `47125`, overridable through `PORT`/`O8_API_PORT` and `WS_PORT`/`O8_WS_PORT`.
- `npm run dev:next`: starts only Next.js.
- `npm run dev:ws`: starts only the WebSocket server.
- `npm run desktop:dev`: alias for the coordinated `npm run dev` stack.
- `npm run desktop:dev:side`: side-by-side dev stack on `3010`/`3011` for installed-app bridge work.
- `npm run build`: production Next.js build using webpack.
- `npm run start`: serves a production Next build, honoring `PORT`.
- `npm run tauri:dev` / `npm run tauri:build`: run or package the native shell.
- `npm run tauri:build:signed`: signed updater-capable build with the MCP feature enabled.

Never copy these fallback ports into application code. The packaged shell chooses ports dynamically and writes `~/.o8/api-port` and `~/.o8/ws-port`; server code should use `getApiBase()` / `resolvePortInfo()`, and standalone CLI/MCP code should use its existing resolver.

## Verification

`npx tsc --noEmit` is the mandatory local completion gate for every code change. `npm run typecheck` is the fuller variant: it clears generated Next types, runs `next typegen`, then runs TypeScript.

Vitest is configured in `vitest.config.ts` with isolated data directories and no global test APIs. Run the smallest relevant test set during iteration (`npx vitest run <paths>`), then `npm test` for the bounded-parallel hermetic completion gate. Use `npm run test:integration` for resource-owning Git, worktree, APFS, subprocess, listener, and native-build tests, or `npm run test:all` to run both lanes with causal summaries. For Rust changes, run the relevant Cargo test from `src-tauri`, normally `cargo test --lib`.

Run `npm run rule-check -- --base=<ref>` for changed TypeScript/TSX. It enforces the changed-line UI/port/path invariants and the file ceiling. Run ESLint only on touched files (`npx eslint <changed files>`); repo-wide `npm run lint` carries known baseline debt and is not a normal packet completion gate.

New cross-process seams, prompt-taught tool arguments, persistence paths, and principal/authorization changes require a test through the real entry point and persisted state. A helper-only unit test does not prove that production callers can reach the behavior. Use `tests/route-coverage.test.ts`, `tests/principal-authz.test.ts`, and `tests/real-path-seams.test.ts` as patterns.

CI currently runs on pull requests and manual dispatch. PRs run typecheck, unit tests, and the governance smoke; full lint and build are manual-dispatch jobs. Do not describe CI from memory—read `.github/workflows/ci.yml` when changing the gate.

## Load-Bearing Code Rules

- Preserve existing worktree changes. Never overwrite unrelated edits, and inspect `git status` before changing files.
- TypeScript is strict. Match the existing two-space, single-quote, semicolon style; use `PascalCase` for components, `camelCase` for functions, and the `@/` alias for `src` imports.
- The default file ceiling is 800 lines. Current mechanical waivers are `src/app/dashboard/page.tsx`, `src/ws-server.ts`, `src/lib/worktree/manager.ts`, and `src/lib/lane/commands.ts`. New waivers require an explicit user decision.
- Do not introduce `className` or new CSS classes in TSX. Use inline style objects. Existing legacy classes do not make new ones acceptable.
- Use longhand spacing properties when multiple values are needed (`paddingTop`, `paddingRight`, etc.); React 19 warns when shorthand and longhand are mixed.
- Use theme variables for themeable surfaces. Do not add hardcoded rgba-white surface colors.
- Do not add emoji UI. Desktop icons must use the established raw-SVG/shim pattern; do not introduce `lucide-react` or React Phosphor component imports into desktop code.
- Keep React hooks unconditional and in stable order; do not put an early `return null` before hooks.
- API middleware is default-deny for `/api/*`. Public routes must be added deliberately to the narrow read/any-method allowlists, and externally reachable self-authenticating routes must verify their own credentials. There is no `GATED_PREFIXES` list.
- API routes should return structured error responses rather than throwing to the framework.
- Do not hardcode `3001`/`3002` or `/Users/example/...` in implementation code. Use the port resolver, `process.cwd()`, `os.homedir()`, `process.env.HOME`, or an explicit env variable.
- Ad-hoc LLM calls go through the existing proxy/routing layer. The sanctioned AI SDK import boundary is `src/lib/chat/gateway-client.ts`; do not spread `ai`/`@ai-sdk/*` imports elsewhere without an explicit architecture change.
- For MCP tools consumed by OpenAI strict mode, keep the top-level input schema a plain object with `properties` and `required`; validate unions or conditional relationships in the handler.

## Commits and Coordination

Use focused, imperative Conventional Commit subjects such as `fix: prevent stale transcript replay`. In packet worktrees, use `o8 packet commit -m "..."` so staging respects packet scope. Outside a packet, do not commit, push, version-bump, ship, or open a PR unless the user requested that action.

When multiple agents are active in the same repository, use `o8 team who`, `o8 team status`, `o8 team tell`, and named leases to coordinate shared operations. Use `o8 lane touches --path <file>` before editing a file another packet may own. Do not install coordination hooks with `o8 team init` unless the operator explicitly asks for them.

## o8 CLI

The `o8` CLI is symlinked onto `$PATH` after o8.app runs once. Inside packet worktrees it resolves packet and lane context from the current directory; operators can use the same control-plane verbs from the repository root. Use it instead of curling the local HTTP API.

```
o8 status                                  # fleet snapshot: packets, lanes, merges, approvals
o8 history <thoughts-thread-id> [--limit 200]  # continuous transcript + audited handoff seams
o8 version                                 # CLI + connected server version
o8 doctor [--reap] [--repair]              # diagnose server/config; reap zombies; repair CLI symlink
o8 app restart [--if-update-pending]        # request a running-app restart
o8 connect [--status]                       # register this machine or list connected machines
o8 disconnect                               # remove this machine from the connected-device registry
o8 mcp install --claude-code|--cursor|--print

# Repository + project registry — works from any cwd against the running app.
# Removal changes o8 state only; local folders, Git history, and remotes stay intact.
o8 repo list
o8 repo add <path>
o8 repo remove <id|name|path>
o8 project list
o8 project create <name> [--repo <id|name|path> ...]
o8 project use <id|name>
o8 project add-repo <project> <repo>
o8 project remove-repo <project> <repo>
o8 project delete <id|name>

# Run a long process the operator can WATCH LIVE (servers, backtests, scripts)
o8 run <cmd...>                            # stream in an o8-owned terminal visible to the operator
o8 run --detach <cmd...>                   # register a server/daemon and return immediately
o8 run --list                              # managed runs with recent exit codes
o8 run stop <run-id>                       # stop a managed run
o8 run -- <cmd...>                         # use -- when the wrapped command has flags

# Packet (your dispatched work) — most auto-resolve the lane from cwd
o8 packet info                             # packet metadata: id, branch, base, runtime, events
o8 packet scope [packet-id]                # scope, directives, file ceiling, overlaps
o8 packet diff [packet-id]                 # committed + uncommitted diff vs base
o8 packet commit -m "<message>"            # scoped stage + commit; prefer over raw git add/commit
o8 packet heartbeat [--lane <lane-id>]     # lifecycle ping; exits 4 outside a packet without --lane
o8 packet report --event progress [--reason "..." --message "..."]   # surface a structured progress/blocker event
o8 packet capture --url <url> --before|--after [--clip <sel>] [--full-page] [--wait-for <sel>] [--hover <sel>] [--click <sel>] [--settle <ms>] [--label "..."]   # screenshot the running app as VISUAL PROOF of a bug/fix
o8 packet mirror-proof --pr <n> [--repo owner/repo] [--packet <id>]  # mirror the packet's before/after proof onto a GitHub PR (release-asset hosted, zero git bloat)
o8 packet log [id] [--follow] [--since <cursor>]         # read or tail lane events
o8 packet runtime-drift                    # exit 5 when the bound runtime drifted
o8 packet stop|cancel [packet-id]           # interrupt and hold; resume with reset/rerun
o8 packet reset [--packet <id>] [--reason "..."]         # wipe worktree + lane, then redispatch
o8 packet retry [--packet <id>] [--reason "..."]         # reset while keeping the worktree
o8 packet rerun --feedback "..." [--packet <id>]         # fresh worker, immediate relaunch
o8 packet steer --message "..." [--packet <id>]          # nudge the warm session
o8 packet merge-preview [--packet <id>]                  # read-only five-layer merge preview
o8 packet review --approve [--expected-sha <sha>] [--commit-message "..."]   # records review, then uses the gated merge path
o8 packet approve-merge [--packet <id>] [--commit-message "..."]   # worker context raises an operator card; it does not self-merge

# Agent message bus — durable repo-scoped addressing with native delivery when available.
o8 presence join --as <agent>               # external session: register name, runtime, repo, and worktree
o8 msg send --to <agent> "<text>"            # persist, mirror to Broadcast, and deliver or queue
o8 msg inbox                                 # read this session's inbox; pass its cursor on the next read

# Mission orchestration — fan out sub-work to fellow agents and track it without leaving the CLI.
o8 worker spawn --title "..." [--body "..."] [--repo <path>] [--runtime r] [--caller <label>]   # one-step outside dispatch; repo stays out of saved Projects and opens as a split pane
o8 mission create --title "..." [--body "..."] [--repo <path>] [--dispatch] [--compare m1,m2] [--runtime r]   # create a transient-repo mission; --dispatch starts it now
o8 mission dispatch [--mission <id>] [--wait] [--watch] [--timeout 2h] [--poll <ms>]   # launch; optionally notify on review/terminal
o8 mission status [--mission <id>] [--cost]             # mission + packet state
o8 mission stop --mission <id>                           # interrupt and hold every packet
o8 mission wait [--mission <id>] [--packet <id>] [--timeout 30m] [--poll <ms>]
o8 mission tail [--mission <id>] [--timeout 30m] [--poll <ms>]

# Governance inbox — the operator approval queue; worker approve-merge cards land here.
o8 inbox list [--all]                  # pending approvals (--all includes resolved)
o8 inbox approve <id>                  # OPERATOR action: approve a card → runs the deferred action (e.g. a held merge)
o8 inbox reject <id>                   # OPERATOR action: reject a pending approval

# Task pool (project-backed work queue)
o8 task list [--include-done] [--include-brief] [--project <id>] [--repo <path>]   # pool grouped ready/running/review/blocked/done
o8 task create --title "..." [--summary "..." --project <id> --repo <path>]        # add a task to the ready pool
o8 task brief <id>                     # full project-backed brief for one task
o8 task claim <id>                     # bind/reserve a task to a lane
o8 task dispatch <id>                  # launch the claimed task through the selected dispatchable runtime
o8 task block <id> --reason "..."      # mark a task blocked
o8 task report <id> --event "..."      # append a task progress event
o8 task archive <id>                   # prune/archive a stale task row
o8 task prune <id>                     # permanently remove a done/archived task row

# Same-repo coordination (git-native; no server required)
o8 team who
o8 team status "<one-line status>"
o8 team tell @<handle> "<message>"
o8 team inbox [--all]
o8 team lease list
o8 team lease acquire <name> [--note "..."] [--ttl <minutes>]
o8 team lease release <name>

o8 lane touches --path <file>          # other lanes touching the same file (or --packet <id>)

# Engineering Brain — ASK it instead of grepping for conventions, history, or ownership.
# Returns an answer + titled citations in seconds; auto-scopes to your packet's repo from cwd.
o8 ask "<question>" [--repo <path>] [--terse]   # e.g. o8 ask "What is the theming rule for surface colors?"

# Brain feedback — workers contribute observations the orchestrator promotes to directives.
# See "Contributing to the brain" below; this is the only way a worker writes to memory.
o8 cortex observe --kind <regression|pattern|gotcha|preference> --text "..." [--scope packet|repo|global]

# Browser — two tiers, one contract. LOCALHOST pages ride o8's embedded browser
# (canvas browser cards / Browser tab — ghost cursor paints so the operator watches);
# `open` with an EXTERNAL url auto-routes to the ENGINE tier (headless installed-Chrome,
# live-viewed in the canvas as an "Agent Chrome" tab), and later verbs stick with the
# engine while its page is open (--surface canvas|panel|engine overrides). Every call
# from a packet worktree lands in the lane audit trail as `browser_acted`.
o8 browser open [url]
o8 browser read [--selector <css>] [--max-chars <n>] [--surface ...]
o8 browser click "<selector>"          # click an element (selector from `read`)
o8 browser type "<selector>" <text…> [--submit]   # type into an input; --submit presses Enter
o8 browser grab "<selector>"           # rich style/accessibility payload for one element
o8 browser wait "<selector>" [--text <s>] [--timeout <ms>]   # poll until the selector (and text) resolves
o8 browser close                       # end this scope's engine (headless Chrome) session

# o8.md review surface — the operator authors o8.md; you ANNOTATE it (never overwrite).
o8 spec read     [--repo <path>]       # raw o8.md content
o8 spec index    [--repo <path>]       # structured review threads + summary
o8 spec pending  [--repo <path>]       # only the UNRESOLVED threads (what to address)
o8 spec check    [--repo <path>]       # validate the review markup
o8 spec comment  [--repo <path>] --body "<thought>" [--anchor "<snippet>"] [--by AI]
o8 spec reply    [--repo <path>] --to <id> --body "<msg>" [--by AI]
o8 spec resolve  [--repo <path>] --id <id> [--summary "<note>"]
o8 spec suggest  [--repo <path>] --kind add|del|sub --anchor "<text>" [--text "<add>"] [--new "<replacement>"]
```

Claude and Codex sessions receive addressed messages through their native user-turn path when o8 has a live session binding. Other runtimes must run `o8 msg inbox` at turn start and continue from the returned cursor. Every message remains in the durable inbox when native delivery is unavailable.

Output is JSON by default (pass `--human` for pretty ANSI). Errors use stable schemas and exit codes: 1 invalid arguments, 2 connection refused, 3 unauthorized, 4 not found, and 5 conflict. The CLI resolves the active port and bearer token from dispatch env, `~/.o8`, or the legacy fallback; do not replace it with handwritten HTTP calls.

If a command exits 127 (`command not found`), launch o8.app once and run `o8 doctor --repair` after the binary is reachable. If the local control plane is unavailable, continue only with work that does not depend on packet mutation, and report the missing verification boundary.

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

## Working in public

This repository is public. Your packet reports, commit messages, `o8 cortex observe` notes that become directives, and anything you write into issues or PRs will be read by strangers.

- Describe the mechanic, never the source — no names of people, creators, or competitor products as the origin of an idea. Prior-art study belongs in the maintainers' private notes, not here.
- Never edit a published issue/PR body to remove something — public edit history makes removal worse than the original. Surface it to the operator instead.
- Scan any log or screenshot for tokens, home paths, machine names, and infrastructure internals before it goes into a public surface.
- Never force-push, rewrite, or delete history. Tree removal is not history removal — de-publicizing a file is an operator decision, not a commit.
