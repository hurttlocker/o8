# CLAUDE.md

This file guides Claude Code (and, via `AGENTS.md`, every other coding agent) when working in this repository.

## What Is This

**o8** is a Next.js 16 + Tauri v2 desktop app — **the governance layer for autonomous engineering teams**. Approvals, audit, organizational memory, and mobile operator control across any AI provider.

The shipping pattern: an orchestrator agent plans and reviews; worker agents execute in isolated git worktrees. Twelve runtime adapters (Codex, Claude Code, Gemini, opencode, Cursor, Grok, and friends) route through one universal CLI-based adapter interface (`src/lib/runtimes/`), with separate desktop and mobile surfaces. o8 runs on the subscriptions you already own — it spawns the same CLIs you'd run by hand (your ChatGPT/Codex plan, your Claude plan, your Gemini auth) and adds governance on top. No metered API keys required for the core loop.

See `docs/how-o8-works.md` for the product story and `docs/system-architecture.md` for the full diagram.

## Commands

```bash
# Development
npm run dev              # Next + ws-server together (kills stale ports) — default
npm run dev:next         # Next.js dev server alone → http://localhost:3001
npm run dev:ws           # WebSocket server alone → ws://localhost:3002
cargo tauri dev          # Tauri native shell (from src-tauri/)

# Verification (run before every commit)
npx tsc --noEmit         # Quick type check
npm run typecheck        # Full: rm types cache → next typegen → tsc --noEmit
npm test                 # Vitest unit suite
cargo test --lib         # Rust unit tests (from src-tauri/)

# Build
npm run build            # Next.js production build (webpack)
npm run tauri:build      # Unsigned native macOS app

# Lint
npm run lint             # ESLint (flat config)
```

**Test runner: vitest** (`vitest.config.ts`). Tests live colocated as `src/**/*.test.ts` plus cross-cutting suites in `tests/`. The `@` alias resolves; Next's `server-only` poison-pill is stubbed via `tests/stubs/server-only.ts`. Tests import `{ describe, it, expect }` from `'vitest'` explicitly (no globals). Key suites: `tests/middleware-gate.test.ts` (the loopback/token auth gate — add a case for every new gated route), `tests/route-coverage.test.ts` (filesystem-driven: every `src/app/api/**/route.ts` must resolve to an explicit middleware policy — a new unclassified route FAILS), `tests/principal-authz.test.ts` (the operator/worker/remote capability matrix through real route handlers).

### Real-path tests (the reachability rule)

**A new cross-process seam, prompt-taught tool argument, or authorization check requires a test through the REAL entry point against persisted state — never the guard or helper in isolation.** Testing the mechanism with direct arguments while never exercising the path real callers take is the "green tests encode the premise" trap: the mechanism works, but nobody reaches it. We learned this the hard way — twice, a fully unit-tested guard shipped with hundreds of green tests while the real call path never reached it. Drive the actual route handler / prompt assembler / dispatch chain with a constructed Request (or persisted rows), and assert the observable effect. Patterns to copy: `tests/principal-authz.test.ts`, `tests/route-coverage.test.ts`, `tests/real-path-seams.test.ts`.

## CI Pipeline (`.github/workflows/ci.yml`)

Runs on push/PR to `main`: TypeCheck → Lint → Unit Tests → Governance Smoke → Build (Node 22, `npm ci`).

## Path Aliases

`@/*` maps to `./src/*`. All imports use `@/lib/...`, `@/components/...`, etc.

## Design Philosophy

**Steve Jobs lens.** Every pixel matters. Density with restraint. Progressive disclosure. If Apple wouldn't ship it, neither do we.

**Karpathy lens (Software 3.0).** Control plane, not an editor. Intent over instruction. Observable agents. Human oversight as a feature, not a bottleneck.

**Eye-ergonomics lens.** Tune icons, font weights, stroke widths, and contrast for the human eye — not for the design system's defaults. Sustained all-day legibility beats spec fidelity. The locked typography, icon, and layout values live in [`hurttlocker.md`](./hurttlocker.md) — read it before changing any row geometry, font weight, or chrome icon.

**Design language.** [`DESIGN.md`](./DESIGN.md) is the authoritative palette, typography, and motif vocabulary. [`STYLEGUIDE.md`](./STYLEGUIDE.md) covers the interaction half: feedback-timing tiers, sibling cohesion, button hierarchy.

## Architecture

### Desktop Layout (`src/app/dashboard/page.tsx`)
```
┌────────────────────────────────────────────────────────────────────┐
│ TitleBar  (drag region · traffic lights · Agents / Alerts buttons)  │
├──────────────────────┬──────────────────────────┬──────────────────┤
│   AgentPanel (left)   │  TileContainer (center)  │  O8Panel (right) │
│   resizable column    │  WorkspaceTerminal tiles │  440px default   │
│   project drawer      │  with per-column strips  │  workspace · prs │
│                       │                          │  activity· inbox │
├──────────────────────┴──────────────────────────┴──────────────────┤
│ DesktopStatusBar  (Settings · Ports · Add-repo · Terminal · Theme)   │
└────────────────────────────────────────────────────────────────────┘
```

The Orchestrator is a TAB inside WorkspaceTerminal (`OrchestratorTab.tsx`), not a floating tile. A fresh workspace has two default tabs: `Orchestrator` and the assistant chat (`llm-chat`). Mission state lives in `OrchestratorDataProvider` (`components/desktop/orchestrator-data-context.tsx`); consumers use `useOrchestratorData()`.

### Runtime Adapter System (`src/lib/runtimes/`)

Universal `AgentRuntime` interface (`types.ts`) with capability-gated discovery. UI never talks to a specific runtime directly — always through the registry (`registry.ts`). All adapters share: discover, readTranscript, launch, resume, interrupt, reviewDiffs.

**Adding another runtime is a 6-file patch.** See [`docs/runtime-adapter-contract.md`](./docs/runtime-adapter-contract.md) for the exact recipe:
1. `src/lib/<runtime>/owned.ts` — adapter + owned-session store
2. `src/lib/runtimes/<runtime>.ts` — `AgentRuntime` implementation
3. `src/lib/runtimes/<runtime>-cost-parser.ts` — telemetry parser
4. `src/lib/orchestrator/types.ts` — add literal to `OrchestratorRuntime` union
5. `src/lib/orchestrator/runtime-capabilities.ts` — add row to `ORCHESTRATOR_RUNTIMES`
6. `src/lib/runtimes/index.ts` — register adapter + cost parser

After step 4, `npx tsc --noEmit` points to every dispatch switch needing a new case.

### WebSocket Server (`src/ws-server.ts`)

Separate process on port 3002 (proxied via Next rewrite at `/ws`). Multiplexes real-time data for mobile clients. Channel semantics matter: **LOSSY** channels (`chat` deltas, `terminal` data) drop intermediate messages under backpressure; **DURABLE** channels (`inbox`, `history`, `review`, `lane-lifecycle`) are queued with safety-net polling fallback. Backpressure: 64KB buffer limit, max 32 queued messages, 50ms flush interval.

### Desktop vs Mobile

**Completely separate codebases by design.** No shared components. Mobile (`src/components/mobile/`) is a remote control surface, not a scaled-down desktop.

### Database (`src/lib/db/`)

SQLite via better-sqlite3 + Drizzle ORM. Data dir: `~/.o8/` (override: `CORTEX_IDE_DATA_DIR`). WAL mode, FK constraints on. Schema auto-migrates on first `getDb()` call. The main DB is `~/.o8/cortex-ide.db` — lanes, lane_events, approvals, chat history, session outcomes, GitHub mirror. Source of truth: `src/lib/db/schema.ts`.

### Theming (`src/lib/theme/`)

CSS variable system, **two-axis: palette × surface** — `palette` ∈ {light, dark}; `surface` ∈ {glass, solid} (glass bleeds the macOS vibrancy backdrop; solid is the accessibility path). Components reference `var(--t-*)` tokens inside inline styles. The workspace center is always solid — code, chat, and terminal text need a stable paper surface.

### Port resolution (`src/lib/panel/api-port.ts`)

**Never hardcode port 3001/3002.** The Tauri sidecar probes for free ports at startup and writes them to `~/.o8/{api-port,ws-port}`. Resolve via `getApiBase()` from `@/lib/panel/api-port` (server-side TS) or the file fallback (standalone processes).

### API security (`src/middleware.ts`)

Global Next middleware, Node runtime, **default-deny**: every `/api/*` request is gated on loopback origin + bearer token UNLESS it matches an explicit escape. There is no fail-open family — an unlisted new route is denied, not exposed. In packaged builds the bundled server stamps the real TCP peer address into a trusted header; a non-loopback socket can ONLY pass with the bearer token. Full model: [`docs/loopback-api.md`](./docs/loopback-api.md).

**Never add a route that touches agent/repo state without going through this gate.** If you need public access, put it under `/api/setup/*` as GET-only, or add an explicit allowlist entry — and update `tests/route-coverage.test.ts`'s expectations plus this file together.

### MCP servers (`src/lib/mcp/`)

Two stdio MCP servers expose o8 to MCP clients: `operator-mcp-server.ts` (operator tools: status, send, approve/reject, missions, dispatch, review, merge, the `o8_view_*` webview-control family, the `o8_spec_*` repo-spec tools) and `cortex-mcp-server.ts` (internal tools for orchestrator sessions). Strict-schema caveat: every tool's `inputSchema` top level must be a plain `{type:'object', properties, required}` — no `oneOf`/`anyOf`/`allOf` siblings; some MCP clients reject them and the whole tool list fails to load. Validate in the handler, not the schema.

### Cortex v2 (organizational memory)

`src/lib/cortex/` is the in-process memory subsystem. Two layers, both SQLite-backed: **Directives** (operator-authored rules, surfaced to the orchestrator at session start) and the **Session ledger** (every completed packet writes an outcome row; a proposer surfaces candidate directives when the same fix-pattern recurs — operator accepts or dismisses, never autonomous writes).

**Spec ingestion feedback loop — important.** At repo connect, `spec-ingest.ts` ingests `README.md`, `CLAUDE.md`, `AGENTS.md`, `DESIGN.md` (plus `docs/*.md`) and converts them into directives the Engineering Brain retrieves against. Editing this file immediately changes what the Brain answers about the repo. Sections chunk at the H3 level and the composer reads ~1,500 chars per row — keep H3 sections chunk-sized.

### Engineering Brain (Q&A surface)

The Q&A layer over the Cortex substrate, for every consumer: the operator, the orchestrator, dispatched workers, and MCP clients. Pipeline (`src/lib/cortex/qa/ask.ts`): classify with speculative retrieval overlapped → parallel retrievers + RRF merge with directive pinning → compose. Streams via SSE; every citation carries a human-readable title. Workers get `o8 ask "<question>"` taught in their packet prompt when enabled — instant cited repo answers instead of context-burning searches. Every worker ask is recorded as a `brain_consulted` lane event the operator can audit.

Spend guardrails are built in: paid-tier calls are logged and hard-capped daily; when the cap is hit the cascade falls through to free tiers; a circuit breaker opens on repeated auth failures. A local-inference tier (Ollama-compatible) is supported for classify/compose. **Never weaken the spend guardrails.**

### Orchestrator Model

Multiple orchestrator backends, registry-based (`src/lib/lane/orchestrator-backends/registry.ts`). The orchestrator can EITHER direct-execute in the repo with full native tools OR dispatch workers into isolated worktrees via missions — the turn decides; both are first-class. Governed external backends run against profiles that deny native execution so they can ONLY dispatch through o8's governance. Before any agent merge, the orchestrator reviews the diff (merge preview → review → approve-and-merge).

**The economics are a feature:** each backend runs on the account you already have — a Claude plan powers Claude Code sessions, a ChatGPT plan powers Codex, Gemini auth powers Gemini. o8 adds the governance layer; it doesn't meter your inference.

### Merge-failure escalation chain (5 layers)

When a packet's post-rebase typecheck fails during merge, recovery escalates — cheap and automatic at the bottom, human at the top. The lane never silently stalls:

| Layer | Trigger | Who decides |
|---|---|---|
| 1. Auto-rerun (cap 1) | typecheck fails on merge | system |
| 2. Escalate to orchestrator | layer 1 also fails | system → orchestrator (`awaiting_orchestrator` + full tsc output) |
| 3. Steer warm session | orchestrator picks "fix it where it sits" | orchestrator (`steer_packet` — reuses the warm thread) |
| 4. Fresh redispatch | steering fails or session dead | orchestrator (`rerun_with_feedback`) |
| 5. Human approval card | orchestrator gives up | operator |

Layer 1's retry counter resets on `reset_packet` → dispatch. Prefer layer 3 over 4 — the warm session already has packet context.

### Agent-side CLI (the `o8` binary)

Dispatched agents have the `o8` CLI on `$PATH` inside worktrees — `packet info`, `packet scope`, `packet heartbeat`, `packet report`, `o8 ask`. See [`AGENTS.md`](./AGENTS.md) for the full agent protocol. The CLI is symmetric with the MCP operator tools: the same control-plane verbs reach the same gated routes from either surface. **Governance is gated on context, not verb:** a worker-context `approve-merge` raises an operator approval card; a human operator call merges directly.

## Critical Rules

> **Vocabulary** — [`docs/vocabulary.md`](./docs/vocabulary.md) is the canonical glossary of `runtime` / `agent` / `session` / `packet` / `lane` / `mission` / `review` / `approval`. MCP tool names and DB columns are frozen for stability.

### NEVER
- **Never use CSS classes** — inline styles only (`style={{ }}`). iOS Safari reliability. Permanent.
- **Never hardcode rgba colors for theme surfaces** — use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`. A hardcoded light rgba renders as a gray blob in dark mode.
- **Never hardcode port 3001 or 3002** — use `getApiBase()`.
- **Never hardcode absolute user paths** — use `process.cwd()`, `os.homedir()`, or an env var.
- **Never bypass the middleware gate** — see API security above.
- **Never use emoji in UI** — icon libraries only, as raw SVG. Match whichever library the surrounding surface already uses; don't migrate icons between libraries.
- **Never use React icon components in the Tauri webview** — extract SVG path data and use raw `<svg>` elements.
- **Never use Material Design patterns** — no borderLeft accents, no MD elevation.
- **Never use dropdown overflow menus ("...")** — inline actions with confirmation strips.
- **Never put early `return null` before hooks.**
- **Never use CSS shorthand** — `paddingTop`/`paddingLeft`, not `padding: "8px 16px"`.
- **Never throw in API routes** — return structured error responses.
- **Never use native `<select>` or `<input>` inside packet cards** — Issues-style rows with custom popovers.

### ALWAYS
- **`npx tsc --noEmit` before every commit.**
- **Respect the 800-line file ceiling** — decompose before adding logic past it. Layout orchestrators (`page.tsx`) and multiplexers (`ws-server.ts`) are waived.
- **Apple HIG**: 44px touch targets, 14px card radii, spring curves (framer-motion `stiffness: 400, damping: 30`).
- **`as React.CSSProperties`** for vendor-prefixed CSS props.
- **Build through the runtime contract** — never talk to a specific runtime directly.
- **Console logging prefix**: `[feature-name]`.
- **Commit prefix**: `feat:`, `fix:`, `refactor:`, `perf:`, `chore:`.
- **Smoke-test scripts with `tsx <script>`, never `tsx -e "import(...)"`** — the latter silently loses named exports.

## Environment Variables

See `.env.example` — 40+ documented vars grouped by feature. Most are optional; fresh clones boot with nothing set. `CORTEX_IDE_DATA_DIR` overrides the data dir (default `~/.o8`).

## Git Practices

- Maintainers work on `main`; contributors branch and open PRs.
- `npx tsc --noEmit` + `npm test` green before every commit.
- Commit with explicit pathspecs in agent workflows — never `git add -A`.

## Documentation

`docs/` contains the architecture and contract docs. Start with:
- `docs/how-o8-works.md` — what o8 is and does
- `docs/system-architecture.md` — full system diagram
- `docs/api.md` — `/api/*` route reference
- `docs/runtime-adapter-contract.md` — the adapter interface
- `docs/loopback-api.md` — the API auth gate
- `docs/canonical-workflow.md` — the dispatch → review → merge loop
- `docs/vocabulary.md` — canonical glossary
- `docs/performance-architecture-principles.md` — render speed, bootstrap, streaming
- `docs/product-telemetry-privacy.md` — privacy posture (telemetry is opt-in)
