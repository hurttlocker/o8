# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

**o8** (formerly Cortex IDE) is a Next.js 16 + Tauri v2 desktop app — **the governance layer for autonomous engineering teams**. Approvals, audit, organizational memory, and mobile operator control across any AI provider.

**Shipping runtime pattern:** orchestrator backends and worker runtimes are independent choices. Codex GPT-5.6 Sol is the default direct orchestrator, while the resident Claude Code harness can use its native account, an API gateway, or the experimental local Codex subscription carrier selected in Settings. Dispatched workers run through the normalized runtime registry in isolated worktrees; Codex remains the default worker, but every dispatchable adapter uses the same control and lifecycle contract. The Claude Code path uses interactive `stream-json`, not `claude -p` print mode.

See `docs/user/o8-product-brief.md` for the public product overview.

## Outcome ownership

Translate every request into an observable desired outcome, distinguish symptoms from established facts and root-cause hypotheses, then choose the smallest complete remedy allowed by the task's scope and authority. Read-only and diagnostic work remains non-mutating. Verify through the real entry point because plans, commits, tests, and merges are evidence rather than automatic closure.

The director preserves outcome and closure criteria across durable mission state while individual model turns end normally. Dispatch is a recorded handoff, not proof of completion. Workers report Outcome, Evidence, Residual, and Decision; reviewers independently try to disprove closure and reject symptom-only or unreachable fixes. Critical adjacent findings block or escalate, recurrence-relevant findings receive a bounded fix or follow-up, and unrelated findings do not expand the task.

## Commands

```bash
# Development
npm run dev              # Next + ws-server together (kills stale ports, concurrently) — default
npm run dev:next         # Next.js dev server alone → http://localhost:47120
npm run dev:ws           # WebSocket server alone → ws://localhost:47125
npm run desktop:dev      # Alias for `npm run dev` (kept for muscle memory + Tauri beforeDevCommand)
cargo tauri dev          # Tauri native shell (from src-tauri/)

# Verification (run before every commit)
npx tsc --noEmit         # Quick type check (skips next typegen)
npm run typecheck        # Full: rm types cache → next typegen → tsc --noEmit
npm test                 # Fast hermetic suite; bounded workers, no real Git/process fixtures
npm run test:integration # Resource-owning suite; one disposable process per test file
npm run test:all         # Both gates in order, with causal summaries and fixture receipts
npm run test:watch       # Vitest watch mode
cargo test --lib         # Rust unit tests (from src-tauri/ — utf8_head, Symon fs sandbox, speech_text)

# Build
npm run build               # Next.js production build (webpack, not turbopack)
npm run tauri:build         # Unsigned native macOS app
npm run tauri:build:signed  # Signed (updater-ready) build, passes --features dev-mcp-plugin

# Ship (local release — bypasses CI, publishes to GitHub)
npm version patch            # bump + sync all manifests + tag (runs sync-version.mjs hook)
release_version=$(node -p "require('./package.json').version")
git push origin main "refs/tags/v${release_version}:refs/tags/v${release_version}"
npm run ship                 # build signed + upload via scripts/release.mjs

# Lint
npm run lint             # ESLint (flat config, next core-web-vitals + TS)

# Performance
npm run measure:render   # Bootstrap render speed measurement
```

**Test runner: vitest** (`vitest.config.ts`). Tests live colocated as `src/**/*.test.ts` plus cross-cutting suites in `tests/`. The `@` alias resolves; Next's `server-only` poison-pill is stubbed via `tests/stubs/server-only.ts`. Tests import `{ describe, it, expect }` from `'vitest'` explicitly (no globals). Key suites: `tests/middleware-gate.test.ts` (the loopback/token auth gate — add a case for every new GATED_PREFIXES/allowlist entry), `tests/route-coverage.test.ts` (filesystem-driven: walks every `src/app/api/**/route.ts` and asserts the middleware's *actual* verdict matches the expected policy. Note the real semantics — an unlisted route falls through to `expectedPolicy() = 'gated'`, so a new route that is correctly denied passes silently; the test fires when middleware EXPOSES something the manifest doesn't sanction, not merely because a route is unclassified. Add public/allowlisted routes to the manifest explicitly), `tests/principal-authz.test.ts` (operator/worker/remote capability matrix through the real RF-1 route handlers), `src/lib/util/keyed-promise-chain.test.ts` (merge/surface lock serialization), `src/lib/lane/terminal-states.test.ts`, `tests/retry-budget.test.ts` (#1108 layer-1 budget survives redispatch), `tests/real-path-seams.test.ts` (real-path spot-checks: session-rule inheritance, worker merge-card, retry-budget persist round-trip). Rust unit tests run with `cargo test --lib` from `src-tauri/` (not in CI — the tauri crate needs system webkit deps).

### Real-path tests (reachability rule)

**A new cross-process seam, prompt-taught tool argument, or principal/authorization check requires a test through the REAL entry point against persisted state — never the guard or helper in isolation.** Testing the mechanism via direct arguments while never exercising the path real callers take is the "green tests encode the premise" trap: the mechanism works, but nobody reaches it. Drive the actual route handler / prompt assembler / dispatch chain with a constructed Request (or persisted rows), and assert the observable effect. Two incidents prove the class: **Collide #1305** — 362 green tests, two proposer-lockout holes, because the guard was only unit-tested with direct args, never through a live propose turn. **Session Rules #1329** — 485 green tests, yet worker rule inheritance was unreachable because the dispatched packet was never told its thread id, so `buildSessionRulesBlock` got null; the isolation test passed a threadId directly and stayed green. Patterns to copy: `tests/principal-authz.test.ts` (imports each RF-1 route module, invokes with/without the worker token — not `resolveRequestPrincipal` in isolation), `tests/route-coverage.test.ts` (walks the route filesystem and drives the real middleware, so a route can't ship exposed without an explicit manifest entry), `tests/real-path-seams.test.ts` seam A (persisted rule → `buildPacketPrompt` → assembled prompt).

## CI Pipeline (`.github/workflows/ci.yml`)

Runs on push/PR to `main`: TypeCheck → Lint → Unit Tests (`npm test`) → Governance Smoke → Build (Node 22, `npm ci`). Build and governance-smoke depend on typecheck passing.

## Path Aliases

`@/*` maps to `./src/*` (tsconfig paths). All imports use `@/lib/...`, `@/components/...`, etc.

## Design Philosophy

**Steve Jobs lens.** Every pixel matters. Density with restraint. Progressive disclosure. If Apple wouldn't ship it, neither do we.

**Karpathy lens (Software 3.0).** Control plane, not an editor. Intent over instruction. Observable agents. Human oversight as a feature, not a bottleneck.

**hurttlocker lens (eye ergonomics).** Tune icons, font weights, stroke widths, and contrast for the human eye — not for the design system's defaults. If the spec says weight 400 but it reads thin and strainy at our actual density, bump it. If a Lucide icon disappears against the chrome, swap libraries (Tabler / Iconoir) until it reads. Sustained, all-day legibility beats spec fidelity. When in doubt, ship what's comfortable to *look at for eight hours*, not what matches a Figma frame. **Locked typography + icon + layout values live in [`hurttlocker.md`](./docs/design/hurttlocker.md)** — read it before changing any row geometry, font weight, or chrome icon. Symlinked to `~/hurttlocker.md` for cross-project reference.

**Design language.** See [`DESIGN.md`](./docs/design/DESIGN.md) for the authoritative palette, typography, layout primitives, and motif vocabulary. Sister spec: `o8-site/THEME.md` for the marketing side. Read `docs/design/DESIGN.md` before styling any new surface; read THEME.md before touching the landing.

## Architecture

### Desktop Layout (`src/app/dashboard/page.tsx`)
```
┌────────────────────────────────────────────────────────────────────┐
│ TitleBar  (drag region · traffic lights · Agents / Alerts buttons)  │
├────────────────────────────────────────────────────────────────────┤
│ SessionTimeline  (36px · OFF by default since epic #1089)            │
├──────────────────────┬──────────────────────────┬──────────────────┤
│   AgentPanel (left)   │  TileContainer (center)  │  O8Panel (right) │
│   resizable column    │  WorkspaceTerminal tiles │  440px default   │
│   project drawer +    │  with per-column strips  │  workspace · prs │
│   LeftPanelProject…   │  (tab pills, no global   │  activity· inbox │
│                       │   titlebar inside tiles) │  spec · browser… │
├──────────────────────┴──────────────────────────┴──────────────────┤
│ DesktopStatusBar  (Settings · Ports · Add-repo · Terminal · Theme)   │
└────────────────────────────────────────────────────────────────────┘
```

**NavRail was retired** (epic #1089) — Agents / Alerts buttons live in TitleBar; Settings / Ports / Add-repo live in DesktopStatusBar. Each WorkspaceTerminal tile inside TileContainer owns its own column strip (tab pills, kind switcher) — there is no longer one global title bar for tiles. LLM chat is a tab kind (`llm-chat`) inside WorkspaceTerminal, not a separate right column.

### Runtime Adapter System (`src/lib/runtimes/`)

Universal `AgentRuntime` interface (`types.ts`) with capability-gated discovery. UI never talks to a specific runtime directly — always routes through the registry (`registry.ts`).

**18 dispatchable runtimes** register in `orchestrator/runtime-capabilities.ts` (the count README advertises). Eleven have dedicated adapter files — `codex.ts`, `claude-code.ts`, `gemini.ts`, `antigravity.ts`, `magnitude.ts`, `opencode.ts`, `pi.ts`, `cursor.ts`, `grok.ts`, `prime-agent.ts`, `deepseek-harness.ts` — while `declarative-workers.ts` carries the CLI-described rest (openhands, goose, qwen, qoder, kimi, aider, 3code). All share capabilities: discover, readTranscript, launch, resume, interrupt, reviewDiffs. Codex distinguishes "owned" (IDE-spawned, full control) vs "discovered" (user terminal, read-only) sessions.

`discoverAllSessions()` runs all adapters in parallel via `Promise.allSettled`. `routeAction()` dispatches resume/interrupt to the correct runtime.

**Adding another runtime is a 6-file patch.** See [`docs/internals/runtime-adapter-contract.md`](./docs/internals/runtime-adapter-contract.md) for the exact recipe. Short version:
1. `src/lib/<runtime>/owned.ts` — adapter + owned-session store
2. `src/lib/runtimes/<runtime>.ts` — `AgentRuntime` implementation
3. `src/lib/runtimes/<runtime>-cost-parser.ts` — telemetry parser
4. `src/lib/orchestrator/types.ts` — add literal to `OrchestratorRuntime` union
5. `src/lib/orchestrator/runtime-capabilities.ts` — add row to `ORCHESTRATOR_RUNTIMES` map (label, accentColor, etc.)
6. `src/lib/runtimes/index.ts` — register adapter + cost parser

After step 4, `npx tsc --noEmit` points to every genuine dispatch switch needing a new case.

### WebSocket Server (`src/ws-server.ts`)

Separate process on the WS port (dev 47125, prod 47105; proxied via Next.js rewrite at `/ws`). Multiplexes real-time data for mobile clients.

Channel semantics matter:
- **LOSSY** channels (`chat` deltas, `terminal` data, `pong`): intermediate messages dropped under backpressure
- **DURABLE** channels (`inbox`, `history`, `review`, `conflicts`, `lane-lifecycle`, `agent-lifecycle`, `cortex-changes`): queued, with safety-net polling fallback (8–10s)

Backpressure: 64KB buffer limit, max 32 queued messages, 50ms flush interval.

Architecture: `Mobile ←WS→ ws-server` + HTTP to Next.js API. Supervisor polls runtime inventory via direct function imports (not HTTP).

### Desktop vs Mobile

These are **completely separate codebases** by design. No shared components. Mobile (`src/components/mobile/`) is a remote control surface, not a scaled-down desktop. Desktop (`src/components/desktop/`) is the full dashboard.

### Database (`src/lib/db/`)

SQLite via better-sqlite3 + Drizzle ORM. Data dir: `~/.o8/` (override: `CORTEX_IDE_DATA_DIR`). WAL mode, normal sync, FK constraints on. Schema auto-migrates on first `getDb()` call — markers at `~/.o8/.db-migrated-v*`.

**The main DB file is `~/.o8/cortex-ide.db`** — `lanes`, `lane_events`, `approvals`, `chat_history`, `session_outcomes`, GitHub mirror, etc. all live here (it's the `getDb()` target). Other DBs in the dir: `~/.o8/agent.db` (Symon voice agent), `~/.o8/skeleton.db` (skeleton/render cache); `~/.o8/o8.db` and `~/.o8/cortex.db` are legacy/empty. To inspect lane state directly (debugging phantom/zombie lanes): `sqlite3 ~/.o8/cortex-ide.db "SELECT id,status,session_key,last_event_label FROM lanes WHERE status NOT IN ('merged','archived','released','completed')"`. The app holds this DB open (WAL) — direct writes are visible to the running app on its next read, but its in-memory orchestrator store won't reflect them until a reload.

Core tables (current schema): `users`, `api_keys` (AES-256-GCM encrypted), `usage_logs`, `subscriptions`, `sessions`, `teams`, `team_members`, `waitlist`, `session_outcomes` (Cortex v2 ledger), `lanes`, `lane_events`, `approvals`, `approval_events`, `watched_agents`, `chat_history`, `automations`, `dispatch_rules`, `external_mcp_servers`, `push_subscriptions`, `review_queue`, `supervisor_inbox`, `worker_events` / `worker_runs` / `worker_tokens`, `github_installations` / `github_repositories` / `github_issues` / `github_pull_requests` / `github_sync_state`. FTS5 indexes on comments, docs, facts (migrations v14–v20). Source: `src/lib/db/schema.ts`.

### Theming (`src/lib/theme/`)

CSS variable system, **two-axis: palette × surface** — `palette` ∈ {light, dark} controls the color tokens; `surface` ∈ {glass, solid} controls whether the chrome bleeds the macOS vibrancy backdrop or paints opaque (accessibility / vestibular path). Two shipping palettes (`light`, `dark` — `PaletteId` in `src/lib/theme/registry.ts`); the legacy `midnight` id auto-remaps to `dark` via `LEGACY_THEME_IDS`. `ThemeProvider` applies vars to `<html>` root, persists to localStorage; components reference `var(--t-*)` tokens inside inline styles. **Full detail + vibrancy material notes in "Theme System (current state)" below.**

**Never hardcode rgba colors for theme surfaces.** Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`, etc. A hardcoded `rgba(255, 255, 255, 0.56)` renders as a huge light-gray blob in midnight — see commit 929ffdf for the repo-registry sweep.

### Port resolution (`src/lib/panel/api-port.ts`)

**Never hardcode API/WS ports.** The Tauri sidecar probes the o8 port blocks (`src/lib/panel/port-constants.ts` — prod API 47100-47104, prod WS 47105-47109; dev 47120-47124 / 47125-47129) for free ports at startup and writes the chosen values to `~/.o8/api-port` and `~/.o8/ws-port`. All consumers must resolve the port via:

1. `process.env.O8_API_PORT` (set by sidecar)
2. `process.env.PORT` (Next server runtime)
3. `process.env.O8_DEV_FRONTEND_URL` (dev-bridge mode — prod app launched against a separate Next dev server, this URL is the source of truth)
4. `~/.o8/api-port` file (standalone MCP processes)
5. Default `47100` (`DEFAULT_API_PORT`, sidecar-free workflow)

Server-side TS: `import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port'`. MCP servers that run as standalone node processes duplicate a small `resolveApiBase()` helper because they can't import from `@/lib`.

### API security (`src/middleware.ts`)

Global Next middleware runs in Node runtime and is **default-deny** (`src/middleware.ts`): its `matcher` restricts it to `/api/*`, and every such request is gated on loopback origin + bearer token UNLESS it matches an explicit escape. There is **no fail-open "ungated family"** — an unlisted new route is denied, not exposed (this closed the fail-open + trailing-slash gate class, audit 2026-07-02; the old `GATED_PREFIXES` allowlist was removed). So `/api/panel/`, `/api/orchestrator/`, `/api/cortex/`, `/api/runtime/`, `/api/lanes`, `/api/worktrees`, `/api/review/`, `/api/board`, `/api/command-center/`, `/api/codex/`, `/api/operator/`, `/api/v2/*` (keys/files/context/chat/proxy/repos), `/api/tasks/`, `/api/mobile/`, `/api/browser/*`, `/api/tts`, etc. are all gated by default.

- **Socket truth in packaged builds**: the bundled `out/server/server.js` (generated by `scripts/tauri-export.mjs`) stamps the real TCP peer address into `x-o8-client-addr` on every request, overwriting any client-supplied value. When present, the middleware treats it as authoritative — a non-loopback socket can ONLY pass with the bearer token, regardless of Host/Origin/sec-fetch-* (those are all client-controlled). In dev (`next dev`), the header is absent and Host-based heuristics apply (best-effort).
- Loopback (`127.0.0.1`, `localhost`, `tauri://localhost`) passes automatically. `same-origin`/`sec-fetch-site` evidence only counts when the Host is loopback — a LAN browser that loaded our page is same-origin too.
- Cross-origin must present `Authorization: Bearer <ws-token>` matching `~/.o8/ws-token` (constant-time compare). Mobile clients receive the token via the pairing QR or the `#tk=` browser link from MobilePairingView — the `/mobile` page only embeds the token in its HTML for loopback page loads.
- `ALLOWLIST_READ_ONLY` (GET passes without auth): `/api/setup/*`, `/api/v2/auth/*`, `/api/panel/github-device/*`, `/api/panel/github-auth/*`, `/api/panel/status`, `/api/mobile/push/public-key`. `ALLOWLIST_ANY_METHOD` (passes regardless of verb): `/api/panel/github-auth/*` callback.
- **Never add a new route that touches agent/repo state without going through this gate.** If you need public access, put it under `/api/setup/*` as a GET-only endpoint, or add an explicit allowlist entry. Update both this section and `src/middleware.ts` together.

### MCP servers (`src/lib/mcp/`)

Two stdio MCP servers expose o8 to Claude Desktop / Claude Code:
- `operator-mcp-server.ts` — user-facing tools: `o8_status`, `o8_send`, `o8_approve`, `o8_reject`, `o8_history`, `create_mission`, `dispatch_mission`, `get_mission_status`, `submit_review`, `approve_and_merge`, `reset_packet`, `retry_packet`, `steer_packet` (#1129, layer-3 escalation), `cortex_ask` (#915, Engineering Brain Q&A — 90s timeout override), the `o8_view_*` webview control tools, plus the `o8_spec_*` o8.md review tools (`o8_spec_read`, `o8_spec_review_index`, `o8_spec_pending_feedback`, `o8_spec_validate`, `o8_spec_comment`, `o8_spec_reply`, `o8_spec_resolve` — handlers in `operator-handlers/spec.ts`, all thin calls to `/api/repo-spec`). These let external Claude read + annotate a repo's `o8.md`; per the review inversion the operator authors o8.md and agents only annotate, so no overwrite tool is exposed. Mirrored by the `o8 spec …` CLI group (see AGENTS.md).
- `cortex-mcp-server.ts` — internal tools spawned by orchestrator Claude Code sessions (fleet/issues/PRs/approvals/agents)

#### Webview control tools (`o8_view_*`)

The operator MCP server also exposes 12 tools for controlling the running o8 webview directly:

- `o8_view_screenshot` — capture the current window as PNG base64
- `o8_view_snapshot` — numbered accessibility tree for element discovery
- `o8_view_click` — click by ref or coordinates
- `o8_view_type` — type into focused element
- `o8_view_press_key` — keypress (Enter, Tab, ArrowDown, etc.)
- `o8_view_scroll` — scroll the page or a specific element
- `o8_view_read` — visible text of the page
- `o8_view_eval` — run JS in the webview
- `o8_view_navigate` — push a new route via history.pushState
- `o8_view_active_route` — report current route + URL state
- `o8_view_console_errors` — read recent console errors from the webview
- `o8_view_wait_for` — poll until a CSS selector resolves (optional text substring match), caps at 25s

These wrap a Unix socket at `/tmp/tauri-mcp-o8-<user>.sock` exposed by the Tauri `dev-mcp-plugin` feature. Signed/prod builds always include the socket. Dev builds need `cargo tauri dev --features dev-mcp-plugin`.

A sibling family, `o8_browser_read` / `o8_browser_click` / `o8_browser_type` / `o8_browser_wait` (#1232 phase 1), drives o8's EMBEDDED browser (canvas browser cards + the Browser tab) through the same socket — it evals into the in-page agent (`src/lib/browser-agent/page-agent.ts`, `window.__o8BrowserAgent`), which only reaches same-origin/proxied localhost frames. Actions paint a ghost cursor + amber card glow so the operator sees the agent working. Dispatched workers reach the same verbs via `o8 browser <verb>` (CLI → gated `/api/browser/agent` route), and packet-attributed calls record `browser_acted` lane events.

**Known gotchas when driving the webview from another Claude session (#1105):**

- **Eval-based tools time out but the action fires anyway.** `o8_view_type`, `o8_view_eval`, and `o8_view_snapshot` route through `eval_and_await` and can return `"eval_and_await failed: Timeout waiting for ..."` when the JS thread is briefly busy (hydration, route change, streaming response). The underlying side effect — the keystrokes, the `.click()`, the `setter.call(textarea, value)` — **already fired synchronously**. Don't retry on this error; take a screenshot to confirm whether the action happened.
- **If EVERY eval times out (not just under load), suspect the Tauri remote-origin ACL** (#1733/#1734, fixed v0.1.656). The page is served from `http://127.0.0.1:<port>`, which Tauri treats as a REMOTE origin: since Tauri 2.11 every capability that a page-invoked command relies on must carry a `remote.urls` block, and app commands must be covered by the generated `allow-app-ipc` permission (`build.rs` parses `generate_handler!` — a new `#[tauri::command]` is picked up automatically, but a new WINDOW needs the grant added to its capability file). Symptom shape: evals execute but `plugin:mcp|mcp_result` can't return the result.
- **`o8_view_eval` with async user code returns `{}`** — the wrapper doesn't await Promises (#1735). Kick off the async work, stash the result on `window.<key>`, and read it with a second sync eval.
- **CSS pixels ≠ screenshot pixels.** `o8_view_screenshot` returns a bitmap (e.g. 1024×466), but `o8_view_click({x, y})` expects CSS pixels (e.g. 2032×925 on a Retina app). Coords from a screenshot land 50-117% off. **Pattern: find the element via `o8_view_eval` (`el.getBoundingClientRect()` returns CSS coords), THEN pass those coords to `o8_view_click`** — or click by `aria-label` via a `querySelector` eval rather than coordinates.
- **Don't sort buttons by position to find the composer Send.** The right Workspace panel + open dialogs contain buttons at the same y. Use `aria-label="Send (Enter)"` explicitly.
- **Screenshot panics no longer kill the sidecar** (since v0.1.155 / #1109) — but a panicked screenshot still returns an error. Fall back to a coords-only flow if `o8_view_screenshot` errors twice in a row.

The previous standalone `tauri-mcp` node bridge has been retired — the operator MCP server now owns all webview control. Only the `o8` entry remains in `.mcp.json`.

Both bundle via esbuild in `scripts/tauri-export.mjs` → `out/server/*.mjs`. The Tauri sidecar sets `O8_BUNDLED_MCP_PATH` + `O8_BUNDLED_MCP_DIR` so packaged installs launch with `node <bundled>.mjs` instead of dev `tsx` paths. Config generator at `/api/setup/mcp-config` emits the correct command per install mode.

MCP distribution: `/api/setup/claude-desktop` GET/POST writes to `~/Library/Application Support/Claude/claude_desktop_config.json` (or `~/.claude.json`) with merge-preserving logic + `.o8-backup-<ts>` sidefiles. Settings → MCP tab is the user-facing surface.

### Tauri sidecar (`src-tauri/src/lib.rs`)

The Rust shell runs pre-flight checks before spawning any Node process:
1. **Node pre-flight**: resolves `node` via login shell (zsh → bash → sh → which) so Finder-launched apps find nvm/fnm/volta. Verifies version ≥ v22. Shows native dialog (osascript/mshta/zenity) + exits on failure.
2. **Port allocation**: probes free ports, writes to `~/.o8/{api-port,ws-port}`, sets `O8_NODE_BIN`, `O8_API_PORT`, `O8_WS_PORT` env vars for children.
3. **Bundled server spawn**: `node out/server/server.js` on the picked port, plus `ws-server.mjs`, plus the optional `tauri-plugin-mcp` (gated behind `dev-mcp-plugin` Cargo feature).

`tauri-plugin-mcp` is optional — build with `cargo tauri dev --features dev-mcp-plugin` only if you want the AI-agent-driven webview testing plugin. Default builds don't need it.

### Cortex v2 (organizational memory)

`src/lib/cortex/` is the **in-process Cortex v2 memory subsystem** — it is *not* a wrapper around an external `~/bin/cortex` binary (that older shim was removed). Two layers, both SQLite-backed (`session_outcomes` ledger + directives tables in `~/.o8/`):

- **Directives** (explicit): operator-authored rules stored in `directives/`. Surfaced to the orchestrator at session start. Mergeable across repos via `directive-merges.ts`, with cross-repo proposals (`cross-repo-proposer.ts`).
- **Session ledger** (implicit): every completed packet writes a `session_outcomes` row (success / partial / failure + summary + changed files + fix pattern). The auto-directive `proposer.ts` (#746) scans this ledger and surfaces candidate directives to the operator when the same fix-pattern recurs ≥ 3× in 14 days. Operator accepts/dismisses — never autonomous writes.

Supporting machinery: `compactor.ts` + `compactor-scheduler.ts` (ledger pruning, weekly digest cron with `--digest-to` markdown output for #970 phase 2), `decay.ts` (relevance decay over time), `embeddings.ts` (Cortex v2 deliberately kills vector search for the directive path but keeps embeddings for the QA cascade), `indexer/`, `ingest/`, `qa/` (Q&A cascade with classifier + composer + haiku-adapter), `spec-ingest.ts` + `ingest/repo-docs.ts` (spec ingestion at repo connect). FTS5 migrations v14–v20 power text search. `session_outcomes` rows now stamp a `mergedClean` boolean when a worktree merge lands without operator edits — distinguishes "agent shipped clean" from "agent shipped but needed touch-up."

**Spec ingestion feedback loop — important.** At repo connect, `spec-ingest.ts` ingests `ROOT_SPEC_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/design/DESIGN.md', 'THEME.md', 'docs/design/STYLEGUIDE.md']` (plus the rest of `docs/**/*.md`, without duplicates) and converts them into directives that the Engineering Brain retrieves against. **This means editing CLAUDE.md immediately changes what the Brain answers about the repo.** When updating this file (or AGENTS.md / `docs/design/DESIGN.md` / THEME.md), consider that the change is also a documentation update visible to the Brain's Q&A surface — and to any orchestrator that calls `cortex_ask`. Write for both audiences. **Chunk-size rule:** sections chunk at the H3 level and the composer reads at most ~1,500 chars per row (`rowFullText` cap) — a fact buried past that point in a long H3 is retrievable but unreadable to the composer. Keep H3 sections chunk-sized, or split them (live-hit 2026-06-11: the Brain couldn't answer questions about its own spend cap until the section was split into three H3s).

### Engineering Brain (Q&A surface)

Built on top of the Cortex v2 substrate, the **Engineering Brain** is the Q&A layer for every consumer — the operator on screen, the orchestrator, dispatched workers, external MCP clients, and Symon. v1 architecture (2026-06-11):

- **Pipeline** (`src/lib/cortex/qa/ask.ts`): classify (Class A factual / Class B narrative) with **speculative retrieval overlapped** (#1227, retrieval runs while the classifier thinks) → 4 parallel retrievers + RRF `unionMerge` with directive pinning → compose. Streams real tokens via SSE; a `sources` event (count + retrievalMs + top-5 titles) fires BEFORE tokens so surfaces can show "Reading N sources…" live.
- **Every citation carries a human-readable `title`** (`rowDisplayTitle` in `composer.ts`, derived per kind — directive title, PR title, outcome summary head). All surfaces render the same titled-sources contract.
- **Surfaces**: ScratchChat (`O8ScratchChat.tsx`, Review-panel rail — titled pills, click = inline detail card, "X cited · N considered"); orchestrator transcript (cortex_ask renders as a "Brain" chip with the question); Symon (`o8_ask` bridge tool returns titled sources, dock shows a sources line, agent names one source in speech); workers (next section).
- **API**: SSE `/api/cortex/ask` (ScratchChat), JSON `/api/cortex/ask/answer` (MCP `cortex_ask` 90s, the `o8 ask` CLI, Symon bridge). The answer route accepts an optional `packetId` — it resolves the repo scope from the packet's lane and records a `brain_consulted` lane event (question, class, cacheHit, sourcesConsidered, topTitles) for the audit trail.

### Engineering Brain — workers use the Brain

Dispatched workers get `o8 ask "<question>"` taught in their packet prompt when enabled (2026-06-11) — instant cited repo answers instead of context-burning searches. Operator setting `workersUseBrain: off | auto | all` (default **auto** = Brain on only for non-frontier runtime `tier` in `runtime-capabilities.ts`; Codex/Claude/Cursor/Grok are frontier and stay lean, Gemini/opencode are standard, future local models auto-qualify). Per-mission `useBrain` on `create_mission` overrides the setting either way. Resolution lives in `src/lib/orchestrator/brain-access.ts`; injection happens at the single `buildPacketPrompt` chokepoint so every dispatch path (mission, task pool, rerun) inherits. Each worker ask is recorded as a `brain_consulted` lane event the operator can audit.

### Engineering Brain — caching, billing & spend guardrails

- **Caching**: 30-min normalized exact cache + **semantic cache** (#1226, `gemini-embedding-001` @768 dims, cosine ≥ 0.86, scope-fenced per repo/project — a rephrased question answers in ~0.3s). Invalidated on ingest/ledger writes. Single-flight coalesces identical concurrent asks.
- **The Brain's daily OpenRouter spend is hard-capped at $0.50/day** (`O8_QA_OPENROUTER_DAILY_CAP_USD`, enforced in `qa/llm/brain-spend.ts`): every paid call is logged to `usage_logs` as agent `cortex-qa`, and once today's sum reaches the cap the OpenRouter tier throws and the cascade falls through to the free subscription tiers. A 2-strike circuit breaker on 401/402 opens the OpenRouter tier for 10 minutes.
- **Local chat tier (Ollama / OpenAI-compatible)**: free users can opt into `O8_LOCAL_INFERENCE_BASE_URL` + `O8_LOCAL_CHAT_MODEL` for Brain classify/compose and dictation polish. The resolver caches a tags-first `/api/tags` probe with `/v1/models` fallback for ~30s and never returns `via:'local'` for a dead endpoint. Founder/paid plan tokens route to the managed proxy first — never local — because the fast managed call is the perk. Local calls skip the daily spend cap and spend ledger; direct BYO OpenRouter calls still use both guardrails.
- **LLM routing — billing-sensitive**: Claude Haiku/Sonnet tiers run through the **warm REPL pool** (`src/lib/claude-code/warm-repl-pool.ts` — pre-spawned single-use `claude --input-format stream-json` procs, subscription pool, MAX_LIVE=4). OpenRouter is a fallback/speed tier only; subscriptions stay primary; **never weaken the spend guardrails**. The "never use the `ai` SDK" rule still applies for non-Brain LLM calls, with the one carve-out in Critical Rules (the Vercel AI Gateway casual-chat path, `chat/gateway-client.ts`).
- **Parser gotcha**: the stream-json parser dedupes the final assistant replay by "any text already streamed this turn" — NOT by block index (index matching doubled every non-SSE answer, fixed 0.1.346). Check non-SSE consumers (MCP, CLI) when touching `stream-json-parser.ts`.

### Orchestrator Architecture (current — May 2026)

**The Orchestrator is a TAB inside WorkspaceTerminal, not a floating tile.**

A fresh workspace has two default tabs: `Orchestrator` (`kind: 'orchestrator'`) and the assistant chat (`kind: 'llm-chat'`). Both render inside `WorkspaceTerminal`. The full set of tab kinds lives in `workspace-terminal/types.ts`: `'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator'`. ⚠️ Naming gotcha: `kind: 'chat'` is a SINGLE-RUNTIME CLI session (Codex / Gemini / opencode), NOT the casual chat tab — the casual chat is `kind: 'llm-chat'`.

The Orchestrator tab (`workspace-terminal/OrchestratorTab.tsx`) is a single chat surface (the standalone left history sidebar was retired; thread state now persists via `orchestrator-thread-restore.ts` localStorage helpers):

```
┌───────────────────────────────────┐
│  ThoughtsChatPanel                 │
│  + SessionVisualizer (when active) │
│  + OrchestratorEmptyState (idle)   │
└───────────────────────────────────┘
```

- **Body**: `ThoughtsChatPanel` with `emptyStateOverride={<OrchestratorEmptyState/>}` — the empty state is a centered hero ("What should we build in <repo>?") over the composer plus a context-chip row (repo · worktree · branch · agent), and (context-dependent) a row of 6 quick-action text links under the hero ("Review pending agent changes", "What did agents ship today?", etc.). The old 6 quick-action cards moved into the ⌘⇧K `QuickActionPalette` (DISPATCH / DECOMPOSE / FIX / REVIEW / STATUS / CLEAR verb rows — rebound from ⌘K in 0.1.351 to stop colliding with the global CommandPalette). When agent sessions exist, `SessionVisualizer` renders a horizontal strip above the chat.
- **Inline transcript blocks**: orchestrator turns get rolled-up `TurnSummaryCard` ("Worked for X min", #1096) and `ChatActionCard` ("Edited N files" + Undo/Review, #1095) inline blocks. Tool-call pill clusters auto-collapse after 3+ calls (`fix(chat): collapse tool-call pill cluster by default after 3+ calls`).
- **Thread restore**: `orchestrator-thread-restore.ts` persists the last-active thread id + title under `o8:last-orchestrator-thread-id` / `o8:last-orchestrator-thread-title` localStorage keys so the tab spawns with the right label on first paint (no flash from "Orchestrator" to "o8.v1").
- **Permission chip retired (2026-07-11, Q ruling):** the composer always runs full access — the Full/Read-only shield toggle and plan-mode banner were removed from both the orchestrator and worker composers. Do not reintroduce.
- **Past threads** live on the mobile API surface (`/api/mobile/orchestrator/threads`) — desktop reaches the history list through there too. No dedicated desktop sidebar component anymore.

**Mission Control / Packets / Issues** no longer render as a right-side panel inside the Orchestrator tab. They live distributed across:
- **O8Panel right side** (`O8Panel.tsx`) — tab union (`o8-panel/types.ts`): main `workspace · browser · prs · activity · inbox · spec · launcher` + utility (right-rail, launcher-managed) `files · side-chat · review · terminal`. Workspace = working-tree diff with commit cluster; Activity = commits / CI / changelog / packet feed; Inbox = governance Incident Queue; spec = the o8.md surface; PRs routes to `PrPanel`. Tabs render as icon pills in the window top strip (active pill carries its label); some (e.g. PRs) only appear in context.
- **Left sidebar — `LeftPanelProjectFocus`** — AgentsTab inside the project-focus drawer ("control room") surfaces live + archived packets per repo. Clicking a project/repo row only SELECTS it; the drawer opens from the row's hover-revealed chevron (`handleMiniOpenControlRoom` in `AgentPanel.tsx`).
- **Mission state itself** lives in `OrchestratorDataProvider` (data flow below) — the right-side ThoughtsMissionPanel that used to render it is **deleted**. Don't reintroduce.

**Retired surfaces** (do not reintroduce):
- Tile kinds `thoughts`, `mission-control`, `orchestrator-history`.
- Components `OrchestratorChatTile`, `MissionControlTile`, `OrchestratorHistoryTile`, `orchestrator-tile-bus`, `ThoughtsMissionPanel`, `WorkspaceSidePanel` (deleted May 2026 — was zombie code with state-machine wiring around it).

**TILE_LAYOUT_VERSION is 4.** Any persisted layout with the retired kinds gets migrated to a plain `terminal` leaf via `migrateNode()` in `lib/tiles/operations.ts`. Bump the version if you add another breaking change.

**Data flow** — `OrchestratorDataProvider` (`components/desktop/orchestrator-data-context.tsx`) sits in `dashboard/page.tsx` and exposes `{ agents, missionState, workspaceTargets, onMissionStateChange, onLaunchPacket, draftInjection }`. Consumers (OrchestratorTab, AgentPanel, PacketCard, etc.) consume via `useOrchestratorData()` — avoids prop-drilling.

**NavRail discipline** — the left nav rail no longer carries orchestrator-related launchers. The "small panels" (tile layer) are reserved for the global terminal (`contextual-panel` kind). Do not add a Lightbulb/Rocket/Clock back to the NavRail.

**O8 right-panel default width** is 440px, persisted via `o8:right-panel:width-o8` localStorage key. Do not raise the default above 480px — it eats the workspace center on narrow viewports.

**Packet cards use Issues-style rows.** When a packet is expanded (in AgentsTab or anywhere packets surface), metadata (Summary / Runtime / Repo / Branch) renders as clickable rows with uppercase labels + values + chevrons. Click to inline-edit (textarea/input) or open a floating popover (runtime/repo). No native `<select>` or `<input>` boxes in the packet card — they read as chunky bubbles against the Issues density.

### Key Files (largest, most active)

| File | What it does |
|------|-------------|
| `src/app/dashboard/page.tsx` | Main layout orchestrator. Wraps TileContainer in `OrchestratorDataProvider`. |
| `src/components/desktop/AgentPanel.tsx` | Agent fleet view: repo-grouped cards, status groups, activity feed, issues, PRs, CI, deploys. |
| `src/components/desktop/LLMChat.tsx` | Chat panel with LLM conversation (the **Assistant** tab). |
| `src/components/desktop/workspace-terminal/OrchestratorTab.tsx` | The **Orchestrator** tab — single chat surface (ThoughtsChatPanel + SessionVisualizer when active). Thread state persisted via `orchestrator-thread-restore.ts`. |
| `src/components/desktop/OrchestratorEmptyState.tsx` | Orchestrator empty state — centered "What should we build in <repo>?" hero above the composer + context chips. |
| `src/components/desktop/SessionVisualizer.tsx` | Horizontal strip of active agent sessions, shown inside the Orchestrator tab when agents exist. |
| `src/components/desktop/workspace-terminal/orchestrator-thread-restore.ts` | localStorage helpers — restore last-active orchestrator thread id/title across reloads. |
| `src/components/desktop/thoughts/ThoughtsChatPanel.tsx` | Chat transcript + composer for the orchestrator and CLI lanes. Supports `emptyStateOverride` + `fillInput`/`sendNow` imperative methods. |
| `src/components/desktop/O8Panel.tsx` | Right-side wide panel — main tabs workspace / browser / prs / activity / inbox / spec / launcher + utility rail (see `o8-panel/types.ts`). Default width 440px, resizable. |
| `src/components/desktop/pr-panel/PrPanel.tsx` | PR review surface — header + tabs (Changes / Checks / Commits / Reviews). Mounted inside O8Panel's PRs tab. |
| `src/components/desktop/review/ReviewPanel.tsx` | Dedicated Review surface (epic #1085) — one continuous diff, no file-list rail. Mounted in O8Panel's `review` mode. Hosts `O8ScratchChat` (Engineering Brain composer) in its rail. |
| `src/components/desktop/o8-panel/workspace-rail/O8ScratchChat.tsx` | "Ask the Brain" composer — Engineering Brain Q&A surface with structured citations, premium dot + cost-hint legend. |
| `src/components/desktop/thoughts/chat-panel/TurnSummaryCard.tsx` | Inline "Worked for X min" rolled-up transcript card (#1096). |
| `src/components/desktop/thoughts/chat-panel/ChatActionCard.tsx` | Inline "Edited N files" action card with Undo/Review (#1095). |
| `src/components/desktop/repo-focus/LeftPanelProjectFocus.tsx` | Project drawer in the left sidebar — surfaces AgentsTab (live + archived packets), Context, Spec, Files. |
| `src/components/desktop/dictation/DictationHost.tsx` | Push-to-talk voice input — mounted at dashboard level. Hosts the pill overlay + Ctrl+Z hold shortcut. Mic button lives next to Send in the composer. |
| `src/components/desktop/Canvas.tsx` | Bottom workspace: issue viewer, transcript viewer, file viewer, timeline. |
| `src/ws-server.ts` | WebSocket multiplexer for mobile real-time data. |

### API Routes (`src/app/api/`)

All routes use `force-dynamic`. **26 top-level families** (count via `ls src/app/api/`). The middleware gates the dangerous ones — see API security above. Families, grouped by purpose:

- **Desktop / panel**: `/api/panel/*` (repos, commits, PRs, issues, CI, deploys, terminals, search, analytics, approvals, workspaces, github-device, github-auth)
- **v2 surface**: `/api/v2/*` (auth/GitHub OAuth, chat streaming, chat-history, cortex context/config/recall, files, keys, proxy/llm)
- **Mobile**: `/api/mobile/*` (inbox, history, push subscriptions, orchestrator threads)
- **Orchestrator / lanes / runtimes**: `/api/orchestrator/*`, `/api/lanes/*`, `/api/runtime/*`, `/api/operator/*`, `/api/claude-code/*`, `/api/codex/*`
- **Worktrees / review**: `/api/worktrees/*` (merge, conflicts), `/api/review/*` (commit, push)
- **Fleet ops**: `/api/command-center/*` (fleet snapshot, bootstrap), `/api/projects/*`, `/api/board/*`, `/api/tasks/*`, `/api/worker/*`
- **Cortex memory + spec**: `/api/cortex/*`, `/api/repo-spec/*` (powers `o8_spec_*` MCP tools)
- **Integrations**: `/api/github/*`, `/api/browser/*`, `/api/connectors/*`, `/api/cloud/*`, `/api/automations/*`
- **Voice + accessibility**: `/api/dictation/*`, `/api/tts/*`
- **Setup**: `/api/setup/*` (first-run wizard — only family with read-only public allowlist)

If you're documenting a route here, also confirm it's in `GATED_PREFIXES` (or `ALLOWLIST_READ_ONLY`) in `src/middleware.ts`.

### Library Domains (`src/lib/`)

**~74 feature domains.** This grew fast; the canonical list is `ls src/lib/`. Don't try to enumerate every dir here — point at it and call out the load-bearing ones:

- **Runtime layer**: `runtimes/` (18 dispatchable runtimes — 11 dedicated adapters: codex, claude-code, gemini, antigravity, magnitude, opencode, pi, cursor, grok, prime-agent, deepseek-harness; declarative-workers for openhands/goose/qwen/qoder/kimi/aider/3code), `runtime/` (IDE session registries, actions, inventory), per-runtime support dirs `codex/`, `claude-code/`, `gemini/`, `opencode/`, `cursor/`, `grok/`, `pi/`, `prime-agent/`, `deepseek-harness/`. Antigravity and Magnitude currently remain single adapter files under `runtimes/`.
- **Dispatch + lanes**: `lane/` (single-lane logic incl. `worktree-side-merge.ts` + `codex-orchestrator-session.ts`), `lanes/` (multi-lane fleet view), `dispatch/`, `supervisor/`, `intake/`.
- **Orchestrator**: `orchestrator/` (types, backends, runtime-capabilities, auto-compact), `agents/`.
- **Cortex v2**: `cortex/` (see "Cortex v2" section above — directives, ledger, qa, embeddings, indexer, ingest).
- **LLM / chat / approvals**: `llm/` (tools, memory, chat-history-store, context), `chat/`, `approvals/` (store, types, llm gates).
- **Workspace + git**: `workspace/`, `worktree/`, `workspace-terminal/`, `git/`, `github/`, `github-broker/`, `repos/`.
- **Data layer**: `db/` (Drizzle schema, migrations, sessions, usage, missions-store), `query/`, `events/`, `realtime/`.
- **MCP + spec**: `mcp/` (operator + cortex MCP servers, handlers), `o8md/` (o8.md ingestion + review), `spec/`.
- **UI infra**: `theme/`, `desktop/`, `tiles/`, `pretext/`, `skeleton/`, `render/`, `transcripts/`, `diff/`, `json-render/`.
- **Surfaces**: `mobile/`, `panel/`, `command-center/`, `projects/`, `tasks/`, `board/`, `review/`, `operator/`, `slash-commands/`.
- **Integrations + services**: `connectors/`, `cloud/`, `automations/`, `tts/`, `dictation/`, `push/`, `tauri/`, `terminal/`, `browser/`, `workflows/`, `worker/`.
- **Infra utilities**: `auth/`, `setup/`, `api/`, `appearance/`, `alerts/`, `ftux/`, `fleet/`, `hooks/`, `diagnostics/`, `perf/`, `usage/`, `util/`, `codebase-memory/`, `demo/`.

## Critical Rules

> **Vocabulary** — see [`docs/user/vocabulary.md`](./docs/user/vocabulary.md) for the canonical glossary of `runtime` / `agent` / `session` / `packet` / `lane` / `mission` / `review` / `approval`. MCP tool names and DB columns are frozen for stability; UI labels may diverge from them — divergences are documented in that file.

### NEVER
- **Never spread `...statusResult` AFTER session data in `runStatusSnapshot()`** — the `status` RPC response has its own `sessions` key that will clobber real session data from `sessions.list`. Always spread it BEFORE so our keys win.
- **Never use CSS classes** — inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.
- **Never hardcode rgba colors for surfaces** — use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`. Hardcoded `rgba(255,255,255,0.xx)` becomes a light-gray blob in midnight theme. See commit 929ffdf.
- **Never hardcode API/WS ports** — use `getApiBase()` from `@/lib/panel/api-port` (server-side TS) or `resolveApiBase()` helper (standalone MCP node processes). The Tauri sidecar picks ports dynamically from the 47100/47120 blocks and writes them to `~/.o8/{api-port,ws-port}`.
- **Never hardcode `/Users/example/*` paths** — use `process.cwd()`, `os.homedir()`, `process.env.HOME`, or an explicit env var. The clone-readiness audit found 15+ leaks; they've been fixed but don't reintroduce.
- **Never bypass the middleware in `src/middleware.ts`** — it gates all dangerous API routes on loopback + ws-token. If you add a new route prefix that touches state, add it to `GATED_PREFIXES`. If you need public GET access, add it to `ALLOWLIST_READ_ONLY`.
- **Never use emoji** — icon libraries only, as raw SVG. **Both Phosphor and Lucide are in active use across the app** (Lucide via the raw-SVG shim system), with Tabler/Iconoir swaps where eye ergonomics demand (per `docs/design/hurttlocker.md`). No standardization on a single library is planned — don't migrate icons between libraries; match whichever the surrounding surface already uses.
- **Never use Material Design patterns** — no borderLeft accents, no MD elevation
- **Never use React icon components in Tauri webview** — neither `@phosphor-icons/react` nor `lucide-react` render correctly. Extract SVG path data from `@phosphor-icons/react/dist/defs/` and use raw `<svg>` elements. For simple actions (plus/minus), prefer HTML entities.
- **Never use dropdown overflow menus ("...")** — use inline actions with confirmation strips instead
- **Never put early `return null` before hooks** — all hooks must run in same order every render
- **Never use CSS shorthand** — use `paddingTop`/`paddingLeft`, not `padding: "8px 16px"` (React 19 warns on mixed shorthand/longhand)
- **Never throw in API routes** — return structured error responses
- **Never use the `ai` SDK for ad-hoc LLM calls** — direct fetch to `/api/v2/proxy/llm`. The ONE sanctioned exception is the casual-chat path: `src/lib/chat/gateway-client.ts` uses `@ai-sdk/gateway` + `streamText` to stream through the **Vercel AI Gateway** (free `deepseek/deepseek-v3.2` / paid `anthropic/claude-sonnet-4.6`) from `/api/v2/chat`. That file is the only place an `ai`-SDK import belongs — don't add new ones elsewhere, and route everything else through the proxy.
- **Never reintroduce the retired orchestrator tile kinds** — `thoughts`, `mission-control`, `orchestrator-history` are DELETED. The Orchestrator is a tab inside `WorkspaceTerminal` (`OrchestratorTab.tsx`). History and Mission Control are collapsible sidebars INSIDE that tab, not separate tiles, not NavRail launchers. If you need a new orchestrator surface, extend `OrchestratorTab` — do not create a new tile kind. See the "Orchestrator Architecture" section.
- **Never add NavRail launchers for orchestrator/mission/history** — the nav rail's bottom section is reserved for ports, alerts, and settings. The "small panels" (tile layer) are reserved for the global terminal (`contextual-panel`).
- **Never use native `<select>` or `<input>` inside packet cards** — packet metadata rows use Issues-style clickable rows with custom popovers. Native form controls render as chunky bubbles that break the density.

### ALWAYS
- **`npx tsc --noEmit` before every commit**
- **Dispatch smoke-test pattern: use `tsx <script>`, never `tsx -e "import(...)"`.** `tsx -e` resolves local TS modules as a CommonJS namespace and only exposes `default` / `module.exports` — named exports silently return `undefined` at runtime. For fresh-DB verification: `cat > /tmp/smoke.ts <<'EOF' ... EOF` then `CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx /tmp/smoke.ts`. Originally tracked + fixed in #568 (closed).
- **Respect the 800-line file ceiling** — if your changes would push a file past 800 lines, decompose first. Extract helpers, hooks, or modules before adding new logic. Layout orchestrators (`page.tsx`) and multiplexers (`ws-server.ts`) are explicitly waived.
- **Apple HIG**: 44px touch targets, 14px card radii, spring curves
- **`as React.CSSProperties`** when using vendor-prefixed or non-standard CSS props
- **Build through the runtime contract** — Codex and Claude Code are primary, with Gemini/opencode/Cursor/Grok adapters sharing the same surface.
- **Don't build what models will commoditize** — Cost dashboards, context optimization, prompt tools, orchestration quality, and briefing features are table-stakes, never differentiators. Our moats are governance, organizational memory, and the operator approval surface.
- **Console logging prefix**: `[feature-name]` (e.g., `[memory-recall]`, `[compaction]`)
- **Commit prefix**: `feat:`, `fix:`, `refactor:`, `perf:`, `chore:`

## Design Constants

**Don't reference a constants block here — the values have changed multiple times and the spec files are the source of truth.** Read in this order:

1. **[`hurttlocker.md`](./docs/design/hurttlocker.md)** — operator-locked typography, icon vocabulary, layout primitives, hover patterns, row geometry. The locked spec for every list/row/chrome surface.
2. **[`DESIGN.md`](./docs/design/DESIGN.md)** — palette, design language, motif vocabulary.
3. **[`STYLEGUIDE.md`](./docs/design/STYLEGUIDE.md)** — the interaction half (review-gating): feedback-timing tiers, sibling cohesion, button hierarchy. Read before adding a control, a loading state, or a group of sibling elements.
4. **`src/lib/theme/`** — actual `--t-*` token values per palette × surface combination.

Stable invariants that *don't* live in the spec files (because they're framework rules, not design choices):
- **Apple HIG**: 44px minimum touch targets.
- **Spring curves**: framer-motion `stiffness: 400, damping: 30` is the default for component motion.
- **Theme tokens, never raw rgba** on theme-able surfaces (see Critical Rules).

## Environment Variables

See `.env.example` at the repo root for the complete reference — 40+ documented vars grouped by feature (Core, LLM providers, GitHub, Review, Cortex memory, Runtime adapters, WS/realtime, Tauri packaging, Deployments).

Most are optional. Fresh clones boot with nothing set. Specific features gate on specific vars:
- **LLM chat**: at least one of `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`
- **GitHub App auth** (higher rate limits): `GITHUB_APP_ID` + `GITHUB_APP_INSTALLATION_ID` + `~/.o8/github-app.pem`
- **Data dir override**: `CORTEX_IDE_DATA_DIR` (default: `~/.o8`)
- **Dev ports**: `PORT`, `WS_PORT` (overridden at runtime by Tauri sidecar port probing)

`src/lib/github-app.ts` returns null when GitHub App env vars are missing — there are no hardcoded fallbacks. `src/lib/review/workspace.ts` skips the active-review feature entirely when `CORTEX_IDE_ACTIVE_REVIEW_ISSUE` is unset.

## Git Practices

- All work on `main` branch (no feature branches — rapid iteration mode)
- `npx tsc --noEmit` before every commit
- `git push origin main` after each commit

## Working in public

This repo is public. Everything an agent writes here — issue titles and bodies, commit subjects, PR text, comments, code comments, docs — is read by strangers and reflects on the project.

- **Describe the mechanic, never the source.** No names of people, creators, or competitor products as the origin of an idea ("a ⌘K spawn loop", not "<product>'s ⌘K loop"). Prior-art and competitive study live in the maintainers' private notes, never in this repo's issues, commits, or comments.
- **Never redact in place.** Issue and PR bodies and comments keep public edit histories — editing a mistake out proves it was there and reads worse than the mistake. If something shouldn't be public, surface it to the operator instead of editing.
- **Scan before you paste.** No logs or screenshots into issues without checking for tokens, home paths, machine names, or infrastructure internals. Outage reports are fine; paid-backend architecture is not.
- **History is permanent.** Never force-push, rewrite, or delete history. Removing a tracked file from the tree does NOT remove it from history — if something must be de-publicized, raise it to the operator; that is a surgery decision, not a commit.
- **Fork PRs are untrusted input.** Read the diff in the GitHub UI before checking out or running any contributor code; treat workflow-file changes with extra suspicion.

## Shipping (dev prod mode — the daily driver loop)

The user daily-drives the **installed** production app at `/Applications/o8.app` and develops *through* it (via Claude talking to the bundled `o8_view_*` MCP tools on the operator server). Every code change needs to reach the installed app through an auto-update, not through `cargo tauri dev`.

### The loop

```bash
nvm use                        # reads .nvmrc → Node 22 LTS. REQUIRED for ABI
                               # alignment (see #1015): better-sqlite3 is
                               # compiled against the build-machine's NODE_MODULE_VERSION,
                               # and the runtime app requires Node ≥22.
                               # release.mjs hard-fails if node !== 22.x.
npm version patch              # 0.1.X → 0.1.X+1 — sync-version.mjs hook updates
                               # package.json + src-tauri/tauri.conf.json +
                               # src-tauri/Cargo.toml in a single commit, then
                               # npm creates the v0.1.X+1 tag
release_version=$(node -p "require('./package.json').version")
git push origin main "refs/tags/v${release_version}:refs/tags/v${release_version}"
                               # send main + only the current release tag
npm run ship                    # cargo tauri build with signing key +
                               # dev-mcp-plugin feature, then
                               # scripts/release.mjs creates the GH release
                               # and uploads all 4 assets
```

The user's installed `o8.app` sees the new version via the `UpdateCard` component (polls every 30 min or on launch), downloads the signed `.app.tar.gz`, verifies the minisign signature against the pubkey in `tauri.conf.json`, extracts, replaces `/Applications/o8.app`, and relaunches.

### Why local instead of CI

GitHub Actions macOS runners failed because of billing, so the normal release runs locally. The CI release workflow (`.github/workflows/release.yml`) still exists as a **manual-only** fallback (`workflow_dispatch`) — the `v*` tag trigger was **removed** so publishing a release tag no longer starts billed macOS runners automatically. Push only the current tag; never use `git push --tags`, because unrelated historical tags can collide with remote history. Run the workflow on-demand from the Actions tab only when the local ship path is unavailable. It uses the same `TAURI_SIGNING_PRIVATE_KEY` secret; `gh release create` in the local script errors cleanly when the release already exists (use `--clobber` to replace assets).

### Signing

`~/.tauri/cortex-ide.key` is the minisign private key. Its pubkey is embedded in `tauri.conf.json` under `plugins.updater.pubkey`. DON'T rotate without re-signing every future release — the installed app will refuse the update if the signature doesn't validate.

### Release-time build config — device-flow GitHub client id (#1338)

The device-flow "Connect GitHub" CTA only renders when `GITHUB_OAUTH_CLIENT_ID` is present in the packaged server's env. Client IDs are PUBLIC, so `scripts/tauri-export.mjs` bakes it into the generated `out/server/server.js` wrapper at prebuild time, sourced from a `GITHUB_OAUTH_CLIENT_ID` build env var OR `o8.release.json` at the repo root (gitignored — copy `config/o8.release.example.json` and paste the client id once). Absent → the build behaves exactly as before (device flow disabled). Set it once and every `npm run ship` carries it.

### o8_view_* webview tools (lets Claude drive the installed app)

The production build includes the `tauri-plugin-mcp` Rust crate via the `dev-mcp-plugin` Cargo feature (always-on now in `tauri:build:signed`). On launch it opens a Unix socket at `/tmp/tauri-mcp-o8-<user>.sock`. The **operator MCP server** connects to that socket and exposes the 12 `o8_view_*` webview tools (full list under "Webview control tools" in MCP servers above).

`.mcp.json` at the repo root registers only the `o8` operator MCP server. Any new Claude Code session that opens this directory picks it up automatically and the webview tools appear under `mcp__o8__o8_view_*`.

**Known seam issue:** `o8_view_eval` and `o8_view_snapshot` sometimes time out when the webview's JS main thread is busy (streaming orchestrator response, Next.js hydration). `o8_view_screenshot` and `o8_view_navigate` always work because they run on the Rust side. Work around by taking screenshots + clicking via raw coordinates.

## Theme System (current state)

**Two shipping palettes: `light` and `dark`.** The earlier `midnight` id is legacy (auto-remaps to `dark` via `LEGACY_THEME_IDS` in `src/lib/theme/context.tsx`); older docs/memories that say "midnight" mean today's `dark`. The full architecture is **palette × surface** — see Theming under Architecture above.

### Shape of both themes

Both use **translucent glass chrome over the macOS vibrancy backdrop** (when `surface=glass`). `ThemeProvider` forces `--t-chrome`, `--t-bg-gradient`, `--t-chrome-nav` to `transparent` in Tauri for any palette — the difference between light and midnight is the RGBA tint of the *other* panel tokens that paint on top of the vibrancy. The `surface=solid` axis (accessibility / vestibular path) replaces those translucent tints with opaque values.

### The workspace/center is always solid, never glass

`--t-chat-surface-bg`, `--t-canvas-bg`, `--t-terminal-bg` are pinned to solid colors in every palette × surface combination. The LLM chat panel paints `background: var(--t-chat-surface-bg)` over itself, so the center content area never bleeds the vibrancy. Code / chat / terminal text needs a stable paper surface.

### macOS vibrancy material

`src-tauri/src/lib.rs` applies `NSVisualEffectMaterial::HudWindow` at startup. HudWindow is dark, so light-tinted RGBA panels read silver-grey rather than white. A dynamic material swap (Rust side, theme-change event) to let Light use `NSVisualEffectMaterial::Sidebar` or `HeaderView` is still pending — tracked in [[theme_two_axis_architecture]] memory.

### Iterating on theme work

The installed app has `dev-mcp-plugin` enabled. Use `mcp__o8__o8_view_screenshot` after each tweak. Ship with `npm run ship` after each change — ~2 min to build + upload + auto-update. Don't rely on `cargo tauri dev` — the user daily-drives the prod build, so that's where the feedback loop lives.

For exact token values and row/typography geometry, **always** read [`hurttlocker.md`](./docs/design/hurttlocker.md) first — it's the operator-locked spec.

## Orchestrator Model

**Multiple orchestrator backends, one worker runtime contract.** Backend selection is registry-based; `src/lib/lane/orchestrator-backends/types.ts` is authoritative for current `OrchestratorBackendId` values. The `orchestratorBackend` operator setting (Settings → Operator Defaults) picks one, with `'auto'` (default) deferring to the legacy `inAppOrchestratorEnabled` toggle (Claude Code when on, Codex when off). Worker selection is separate and resolves through the runtime registry.

| Backend | When | Billing | Implementation |
|---|---|---|---|
| **Claude Code harness** | Toggle ON / backend = claude | Native Claude account, API-billed OpenRouter model, or experimental Codex subscription carrier, as selected in Settings → Models | `lane/orchestrator-backends/claude.ts` → `lane/orchestrator-session.ts` — resident interactive `stream-json` process; never `claude -p`; one process/session/config per orchestrator chat |
| **Codex GPT-5.6 Sol** | Toggle OFF / backend = codex (default) | Connected Codex subscription | `lane/orchestrator-backends/codex.ts` → `lane/codex-orchestrator-session.ts` — `codex exec --json` with the selected model and effort; maps the Codex JSON stream into the shared `OrchestratorEvent` contract |
| **openclaw** | Mobile-first / governed copies | Sub-billed via openclaw | `lane/orchestrator-backends/openclaw.ts` — spawns `openclaw --profile o8 agent --json` once per turn. Critical: dispatches Codex workers **through the o8 operator MCP** (`o8__dispatch_mission`), not openclaw's native `sessions_spawn` — that tool is `tools.deny`-stripped on the governed `o8` profile, per the structural fix for #1075 (orchestrator-runtime ≠ worker-runtime). Streaming limitation: openclaw `agent --json` returns one final JSON blob, so no live tool/thinking deltas. See `docs/internals/openclaw-integration.md`. |
| **Hermes / ACP** | backend = hermes (or generic `acp`) | Provider configured in Hermes (`hermes setup` — the operator's keys, never o8's) | `lane/orchestrator-backends/acp.ts` — a generic Agent-Client-Protocol backend; Hermes runs against a GOVERNED profile (`hermes-profile.ts`, isolated HOME) that denies its native work toolsets (`delegation` = native spawn, etc.) so it can only dispatch through o8 (#1075). |
| **Collide (MoA)** | backend = collide | Claude Max + Codex sub — ~2× the Claude draw (2 Claude + 1 Codex turn) | `lane/orchestrator-backends/moa.ts` — Mixture-of-Agents: Claude + Codex propose independently (read-only: `toolProfile:'propose'` + `permissionMode:'plan'`, the `proposer-lockout.ts` guard runs live), then Claude aggregates + does the work on the main thread. "The upgraded Claude." Cap-degrade ladder never auto-meters (#1066). |

Same multi-path applies to: auto-review (`lane/auto-review.ts`), GitHub intake (`intake/github-intake.ts`), Q&A cascade (`cortex/qa/classifier.ts` + `composer.ts`), heal-bot (`supervisor/heal-bot.ts`), auto-compact (`orchestrator/auto-compact.ts`), and the post-commit distill hook (`scripts/distill-commit.ts`).

The orchestrator (whichever backend) can EITHER direct-execute in the repo — full native tools (Edit / Write / Bash), always full access (the per-turn Full/Read-only permission chip was retired 2026-07-11) — OR dispatch a registered worker runtime into an isolated worktree via the `mcp__o8__*` mission/dispatch tools. The turn decides; direct execution and dispatch are both first-class. (The openclaw/Hermes governed backends are the exception — their profiles deny native execution so they can ONLY dispatch through o8, the #1075 lockout.) Before any agent merge, the orchestrator reviews the diff (`mcp__o8__o8_merge_preview` → `submit_review` → `approve_and_merge`).

### Agent-side CLI (the `o8` binary)

Dispatched agents inside packet worktrees have the `o8` CLI on `$PATH` (symlinked to `/usr/local/bin/o8` after first o8.app run). See [`AGENTS.md`](./AGENTS.md) for the full command list — `packet info`, `packet scope`, `packet heartbeat`, `packet report --event progress`, `lane touches`, `cortex observe`. Orchestrator instructions in `src/lib/lane/orchestrator.md` reference these so the orchestrator doesn't duplicate the agent's lookups.

**CLI-as-control-plane symmetry:** the `o8` binary is symmetric with the MCP operator tools — the same control-plane verbs reach the same gated `/api/orchestrator/*` + `/api/panel/approvals` routes from either surface, so a human operator (headless) and a self-orchestrating agent both drive the fleet from one binary. Beyond the lookup verbs above: `o8 mission create|dispatch|status|wait|tail` (fan out + track sub-work), `o8 packet reset|retry|rerun|steer|merge-preview|approve-merge` (recovery + the layer-1→4 escalation chain), and `o8 inbox list|approve|reject` (the governance queue). **Governance is gated on context, not verb:** a worker-context `o8 packet approve-merge` does NOT merge — it raises an operator approval card (returns `pending_operator_approval`) that lands in `o8 inbox`; a human operator call merges directly. [`AGENTS.md`](./AGENTS.md) is the command-surface reference.

### MCP surface for orchestrators

The `mcp__o8__*` tool family is the orchestrator's primary interface. Mission/dispatch (`create_mission`, `dispatch_mission`, `get_mission_status`, `wait_for_mission_ready`, `submit_review`, `approve_and_merge`, `reset_packet`, `retry_packet`), webview control (`o8_view_*`), and inbox/approvals (`o8_status`, `o8_send`, `o8_approve`, `o8_reject`, `o8_history`) all flow through the operator MCP server bundled in the Tauri app.

**OpenAI strict-mode caveat (v0.1.142 fix):** every tool's `inputSchema` top-level MUST be a plain `{ type: 'object', properties, required }` — no `oneOf` / `anyOf` / `allOf` / `not` siblings. OpenAI's strict function-calling spec rejects them and the whole turn 400s when any OpenAI-backed MCP client (Codex CLI, Cursor strict mode) loads the tool list. Validate inputs in the handler, not in the schema.

### Merge-failure escalation chain (5 layers, operator-locked 2026-05-25)

When a packet's post-rebase typecheck fails during `approve_and_merge`, recovery escalates through five layers — cheap automatic at the bottom, expensive human at the top. The lane never silently stalls; every failure has a defined next step.

| Layer | Trigger | Cost | Who decides | Code |
|---|---|---|---|---|
| **1. Auto-rerun (cap 1)** | tsc fails on merge | 1 Codex turn | system | `handlePostRebaseTypecheckFailure` in `lane/worktree-side-merge.ts` — counts `typecheck_auto_retry` events since last `session_launched`; if 0, fires `rerunWithFeedback(packetId, tscOutput)` fire-and-forget |
| **2. Escalate to orchestrator** | layer 1 also fails | $0 | system → orchestrator | Same helper sets lane to `awaiting_orchestrator` with structured `blockedReason` + full tsc output as `typecheck_escalation` event payload (≤4KB truncated). Surfaces in `o8_status` automatically. |
| **3. Steer warm session** | orchestrator picks "fix it where it sits" | 1 cheap steer (warm thread) | orchestrator | `mcp__o8__steer_packet({packetId, message})` — reuses Codex `exec resume <threadId>`, model already has packet context. Cheaper + faster than layer 4. |
| **4. Fresh redispatch** | orchestrator picks "start over" or layer 3 fails | full new Codex worker | orchestrator | Existing `mcp__o8__rerun_with_feedback({packetId, feedback})` |
| **5. Human approval card** | orchestrator gives up | $0 | operator | Operator can always intervene via `o8_status` inbox; orchestrator surfaces a card explicitly to flag "I tried 1-4, your call" |

**Lane states involved.** While layers 1–2 run, the lane sits in `recovering` (lane detached from active session, retry pending). On layer-2 escalation it flips to `awaiting_orchestrator`. On layer-5 it flips to `awaiting_human`. A separate but related path — `base-moved` — fires when `main` advances during the awaiting-approval window: layer-1-equivalent auto-rebase + retry runs once before bubbling up (#1130).

**Cost ceiling per failed merge:** 1 extra Codex turn (layer 1) before any human or orchestrator-attention escalation. Past that, the escalation cost is bounded by the orchestrator's decision budget — not runaway retry.

**Counter reset rule:** layer 1's retry counter only includes events newer than the lane's most recent `session_launched`. So `reset_packet` → dispatch starts the counter fresh.

**For the orchestrator (Claude in chat OR external MCP client):** when `o8_status` surfaces a packet at `awaiting_orchestrator` with a `typecheck_escalated:*` event, prefer `steer_packet` first (layer 3, warm session). If steering fails or the session is genuinely dead (no `sessionKey` on lane), fall through to `rerun_with_feedback` (layer 4). Reserve human escalation for cases where the diff itself is fundamentally wrong and no amount of nudging will fix it.

## Development Workflow

### Working on o8 (self-hosting)

This app builds itself. Every code change triggers a hot reload that can kill live state (transcripts, orchestrator sessions). Accept this during dev — Tauri native shell will stabilize it.

### Claude Code patterns for this repo

**Session management:**
- `claude -n "feature-name"` — name sessions for easy resume
- `claude -c` — continue last session after a reload
- `claude -w branch-name` — work in an isolated worktree (matches what agents do)

**Subagents (`.claude/agents/`):**
- Use for isolated tasks that would bloat main context (test runs, log analysis, large file reads)
- Each gets its own context window, tools, and optionally a different model
- Run `/agents` to create interactively

**Hooks (`.claude/settings.json`):**
- PostToolUse hooks for auto-formatting after edits
- PreToolUse hooks to protect critical files
- Notification hooks when Claude needs input

**Monitoring:**
- `/loop 5m check CI status` — background polling while working
- `/cost` — track token usage per session

**Both Claude Code and Codex work in this repo.** Codex sessions can be spawned for isolated tasks. Use the runtime adapter system — never talk to a specific runtime directly.

### Agent delegation (use proactively)

Subagents are defined in `.claude/agents/` (project) and `~/.claude/agents/` (global). **Delegate automatically** — don't wait to be asked:

| When you encounter... | Delegate to |
|---|---|
| Product thinking, "should we...", "what if...", strategy | **brainstormer** (Opus, multi-turn) |
| Research, docs lookup, "what's the best way to..." | **researcher** (Haiku, cheap) |
| Architecture review, system design, multi-file planning | **architect** (Opus, deep) |
| "What changed?", git history, blame, branch analysis | **git-scout** (Haiku, fast) |
| API health, typecheck, "does everything work?" | **smoke-tester** (Sonnet) |
| Post-change review for bugs and rule violations | **reviewer** (Sonnet) |
| Session discovery, gateway, adapter debugging | **runtime-debugger** (Sonnet) |

**Brainstormer pattern:** The brainstormer does all 3 turns internally (explore, self-challenge, lock) in a single invocation. It returns a structured response with Turn 1/2/3 headers. Present only the final locked recommendation to the user. If you want to push back on the result, spawn a new brainstormer with the prior recommendation as context.

Using subagents saves main context and runs cheaper models on tasks that don't need Opus.

## Documentation

[`docs/README.md`](./docs/README.md) is the documentation index. The tree is split by reader:

- `docs/user/` — product behavior and operator workflows.
- `docs/internals/` — architecture, contracts, and extension points.
- `docs/operations/` — verification, deployment, and recovery runbooks.

<!-- Last reviewed: 2026-05-28 (staleness fix after the 97-file cleanup wave — corrected: no test files (was fact-backed.test.ts), UpdateBanner→UpdateCard, de-duped the webview-tools section (stale "7 tools" → 12) + added Theming cross-ref. Verified still-accurate against source: 26 API families, 74 lib domains, TILE_LAYOUT_VERSION 4, all 20 Key Files, Opus 4.7 orchestrator model, tab kinds, /api/v2/chat, spec-ingest.ts.) -->
<!-- Last reviewed: 2026-05-26 (full staleness pass + closed-issues sweep — runtime model, layout diagram, theme system, design constants → hurttlocker.md, Cortex v2 rewrite + Engineering Brain + spec-ingest feedback loop, WS channels, port resolution, middleware GATED_PREFIXES, webview tools 7→12, OrchestratorHistorySidebar removal, DB tables, API families 10→26, lib domains 13→74, three orchestrator backends incl. openclaw, ReviewPanel + TurnSummaryCard + ChatActionCard, cortex_ask MCP tool, recovering lane state, docs/internals/api.md + docs/internals/openclaw-integration.md) -->
