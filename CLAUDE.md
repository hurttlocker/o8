# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

**o8** (formerly Cortex IDE) is a Next.js 16 + Tauri v2 desktop app — **the governance layer for autonomous engineering teams**. Approvals, audit, organizational memory, and mobile operator control across any AI provider. Claude is the orchestrator/brain; Codex is the workhorse executing tasks in worktrees. It runs three agent runtimes (OpenClaw, Codex, Claude Code) through a universal CLI-based adapter interface, with separate desktop and mobile surfaces.

See `docs/o8-product-brief.md` for the full product vision, monetization, and Karpathy alignment.

## Commands

```bash
# Development
npm run dev              # Next.js dev server → http://localhost:3001
npm run dev:ws           # WebSocket server → ws://localhost:3002
npm run desktop:dev      # Both together (kills stale ports, concurrently)
cargo tauri dev          # Tauri native shell (from src-tauri/)

# Verification (run before every commit)
npx tsc --noEmit         # Quick type check (skips next typegen)
npm run typecheck        # Full: rm types cache → next typegen → tsc --noEmit

# Build
npm run build            # Next.js production build (webpack, not turbopack)
cargo tauri build        # Native macOS app (from src-tauri/)

# Lint
npm run lint             # ESLint (flat config, next core-web-vitals + TS)

# Performance
npm run measure:render   # Bootstrap render speed measurement
```

**No test runner is configured.** There are no jest/vitest/playwright configs and no `test` script. The single test file (`src/lib/cortex/fact-backed.test.ts`) exists but has no harness.

## CI Pipeline (`.github/workflows/ci.yml`)

Runs on push/PR to `main`: TypeCheck → Lint → Build (Node 22, `npm ci`). Build depends on typecheck passing. No automated tests.

## Path Aliases

`@/*` maps to `./src/*` (tsconfig paths). All imports use `@/lib/...`, `@/components/...`, etc.

## Design Philosophy

**Steve Jobs lens.** Every pixel matters. Density with restraint. Progressive disclosure. If Apple wouldn't ship it, neither do we.

**Karpathy lens (Software 3.0).** Control plane, not an editor. Intent over instruction. Observable agents. Human oversight as a feature, not a bottleneck.

## Architecture

### Desktop Layout (`src/app/dashboard/page.tsx`)
```
┌─────────────────────────────────────────────────┐
│ TitleBar (44px, drag region, traffic lights)     │
├─────────────────────────────────────────────────┤
│ SessionTimeline (36px, day-level activity)        │
├──────┬──────────────────────┬───────────────────┤
│ Nav  │    AgentPanel (left)  │  Center Workspace │ Chat │
│ Rail │    or IntentCanvas    │  (Canvas/Settings) │      │
│ 56px │    or SettingsPage    │                    │      │
└──────┴──────────────────────┴───────────────────┘
```

### Runtime Adapter System (`src/lib/runtimes/`)

Universal `AgentRuntime` interface (`types.ts`) with capability-gated discovery. UI never talks to a specific runtime directly — always routes through the registry (`registry.ts`).

Three adapters: `openclaw.ts`, `codex.ts`, `claude-code.ts`. All share capabilities: discover, readTranscript, launch, resume, interrupt, reviewDiffs. Codex distinguishes "owned" (IDE-spawned, full control) vs "discovered" (user terminal, read-only) sessions.

`discoverAllSessions()` runs all adapters in parallel via `Promise.allSettled`. `routeAction()` dispatches resume/interrupt to the correct runtime.

### WebSocket Server (`src/ws-server.ts`)

Separate process on port 3002 (proxied via Next.js rewrite at `/ws`). Multiplexes real-time data for mobile clients.

Channel semantics matter:
- **LOSSY** channels (`chat` deltas, `terminal` data, `pong`): intermediate messages dropped under backpressure
- **DURABLE** channels (`inbox`, `history`, `review`, `conflicts`): queued, with safety-net polling fallback (8–10s)

Backpressure: 64KB buffer limit, max 32 queued messages, 50ms flush interval.

Architecture: `Mobile ←WS:3002→ ws-server ←WS:18789→ OpenClaw Gateway` + HTTP to Next.js API

### Desktop vs Mobile

These are **completely separate codebases** by design. No shared components. Mobile (`src/components/mobile/`) is a remote control surface, not a scaled-down desktop. Desktop (`src/components/desktop/`) is the full dashboard.

### Database (`src/lib/db/`)

SQLite via better-sqlite3 + Drizzle ORM. Data dir: `~/.cortex-ide/` (override: `CORTEX_IDE_DATA_DIR`). WAL mode, normal sync, FK constraints on.

Schema has 8 tables: users, api_keys (AES-256-GCM encrypted), usage_logs, subscriptions (Stripe), sessions (JWT), teams, team_members, waitlist.

### Theming (`src/lib/theme/`)

CSS variable system with 60+ tokens per theme. Two themes: "light" and "chocolate". `ThemeProvider` applies vars to `<html>` root, persists to localStorage (`cortex-theme` key). Components reference `var(--t-*)` tokens inside inline styles.

### Cortex Memory Integration

`src/lib/cortex/client.ts` wraps the `~/bin/cortex` CLI binary. Three client variants: `LocalCortexClient` (exec), `CloudCortexClient` (HTTPS), `HybridCortexClient`.

### Key Files (largest, most active)

| File | What it does |
|------|-------------|
| `src/app/dashboard/page.tsx` | Main layout orchestrator. All panels toggled here. |
| `src/components/desktop/AgentPanel.tsx` | Agent fleet view: repo-grouped cards, status groups, activity feed, issues, PRs, CI, deploys. |
| `src/components/desktop/LLMChat.tsx` | Chat panel with LLM conversation, message rendering, tool calls. |
| `src/components/desktop/Canvas.tsx` | Bottom workspace: issue viewer, transcript viewer, file viewer, timeline. |
| `src/components/desktop/ThoughtsCard.tsx` | Floating glass overlay — mini chat, approvals, agent picker. z-index 9999. |
| `src/ws-server.ts` | WebSocket multiplexer for mobile real-time data. |

### API Routes (`src/app/api/`)

All routes use `force-dynamic`. 16+ feature domains, 120+ route files. Key families:
- `/api/panel/*` — Desktop panel data (repos, commits, PRs, issues, CI, deploys, terminals, search, analytics, approvals, workspaces)
- `/api/v2/*` — v2 API layer: auth (GitHub OAuth), chat (streaming), chat-history, cortex (context/config/recall/action), files, keys, proxy/llm
- `/api/mobile/*` — Mobile inbox, history, Cortex memory
- `/api/command-center/*` — Fleet snapshot, bootstrap
- `/api/board/*` — Task board endpoints
- `/api/worktrees/*` — Git worktree management (merge, conflicts)
- `/api/review/*` — Code review workflow (commit, push)
- `/api/setup/*` — First-run setup wizard (config detection)
- `/api/claude-code/*`, `/api/codex/*`, `/api/openclaw/*` — Per-runtime endpoints

### Library Domains (`src/lib/`)

37+ feature domains. Key ones:
- `runtimes` — Adapter registry (OpenClaw, Codex, Claude Code)
- `runtime` — IDE session registries: `ide-session-registry.ts`, `ide-llm-chat-registry.ts`, `ide-terminal-state.ts`, `ide-surface-state.ts`, `actions.ts`, `inventory.ts`
- `openclaw` — Gateway client (`wsRpc()` WebSocket RPC)
- `llm` — LLM subsystem: `tools.ts` (tool definitions), `memory.ts` (memory management), `chat-history-store.ts` (persistent storage), `context.ts`
- `approvals` — Approval workflows for LLM actions (`store.ts`, `types.ts`, `llm.ts`)
- `workspace` — Workspace lifecycle management and persistence
- `worktree` — Git worktree management (conflicts, launch, manager)
- `board` — Task board state and types
- `cortex` — Memory recall/import client
- `db` — Drizzle schema + SQLite
- `theme` — CSS variable system
- `panel` — Panel auth (loopback host checking + token verification)
- `mobile` — Mobile-specific: inbox filter, sounds, types, OpenClaw bridge
- `terminal` — PTY/tmux tab state
- `connectors` — External service connectors (OpenClaw beta)

## Critical Rules

### NEVER
- **Never use the OpenClaw CLI for status/session queries** — `openclaw status --json` and `openclaw gateway call status --json` hang indefinitely on some configurations. Use WebSocket RPC via `wsRpc()` in `src/lib/openclaw/gateway-client.ts` instead. The gateway WebSocket (`ws://127.0.0.1:{port}`) with challenge-response auth returns sessions in <500ms. CLI is kept ONLY as a last-resort fallback with a 10s timeout.
- **Never spread `...statusResult` AFTER session data in `runStatusSnapshot()`** — the `status` RPC response has its own `sessions` key that will clobber real session data from `sessions.list`. Always spread it BEFORE so our keys win.
- **Never use CSS classes** — inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.
- **Never use emoji** — Lucide icons only across all surfaces
- **Never use Material Design patterns** — no borderLeft accents, no MD elevation
- **Never use Lucide React components in Tauri webview** — use raw `<svg>` elements (they render as empty boxes in Tauri)
- **Never put early `return null` before hooks** — all hooks must run in same order every render
- **Never use CSS shorthand** — use `paddingTop`/`paddingLeft`, not `padding: "8px 16px"` (React 19 warns on mixed shorthand/longhand)
- **Never throw in API routes** — return structured error responses
- **Never use `ai` SDK** — direct fetch to `/api/v2/proxy/llm` route

### ALWAYS
- **Gateway communication goes through WebSocket RPC** — `wsRpc()` in `gateway-client.ts` is the primary path. It opens a short-lived WS, does challenge-response auth (client ID must be `'gateway-client'`), sends the RPC, returns the result. This replaced the CLI fallback that was hanging indefinitely.
- **`getGatewayStatus()` must call `runStatusSnapshot()` directly** on cold start — never rely on the background refresh loop for initial data. The background loop is only for cache refreshes.
- **`npx tsc --noEmit` before every commit**
- **Apple HIG**: 44px touch targets, 14px card radii, spring curves
- **`as React.CSSProperties`** when using vendor-prefixed or non-standard CSS props
- **Build for all three runtimes** — OpenClaw, Codex, Claude Code. Never commit to one provider.
- **Don't build what models will commoditize** — Cost dashboards, context optimization, prompt tools, orchestration quality, and briefing features are table-stakes, never differentiators. Our moats are governance, organizational memory, and the operator approval surface.
- **Console logging prefix**: `[feature-name]` (e.g., `[memory-recall]`, `[compaction]`)
- **Commit prefix**: `feat:`, `fix:`, `refactor:`, `perf:`, `chore:`
- **Public changelog safety**: Commit messages are synced (sanitized) to the public repo `hurttlocker/Rainwater`. When introducing a new internal codename, framework, or tool name, add it to BOTH the sed filter AND the blocklist in `.github/workflows/sync-changelog.yml`. The blocklist will fail the workflow if anything leaks.

## Design Constants

```
Colors:
  accent: #2563eb (blue)         brand: #ef4444 (red)
  bg: #f5f7fb                    panel: rgba(255,255,255,0.82)
  text: #111827                  muted: #5b6475
  Status: running=#22c55e, idle=#9ca3af
  Timeline: coding=#2563eb, thinking=#93c5fd, testing=#f59e0b, error=#ef4444

Radii: 14px cards, 12px buttons/containers, 10px pills, 8px tags
Touch: 44px minimum targets
Spring: stiffness 400, damping 30 (framer-motion)
Letter spacing: -0.01em body, -0.02em headings, -0.03em hero
Font: system-ui, SF Mono/Menlo for monospace
```

## Environment Variables

- `GITHUB_OAUTH_CLIENT_ID` — GitHub device flow OAuth
- `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` — AI provider keys
- `CORTEX_IDE_DATA_DIR` — Custom data dir (default: `~/.cortex-ide`)
- `WS_TOKEN` — WebSocket auth token
- `WS_PORT` — WebSocket port (default: 3002)

## Git Practices

- All work on `main` branch (no feature branches — rapid iteration mode)
- `npx tsc --noEmit` before every commit
- `git push origin main` after each commit

## Orchestrator Model

**Claude is the orchestrator. Codex is the workhorse.** This is the core product decision.

- Claude plans, reviews, routes, and maintains rhythm. It does NOT execute coding tasks in worktrees.
- Codex (xhigh reasoning) executes scoped tasks in isolated worktrees, never touching main.
- The orchestrator spawns and manages Codex sessions via the Codex CLI adapter, not Claude Code sessions.
- Before any agent merge, the orchestrator reviews the diff — a trust layer before GitHub bots.
- Advanced users can override routing, but the default is opinionated: Claude thinks, Codex builds.

This lets users get more compute across both plans simultaneously instead of burning through one.

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

**Multi-turn brainstorming pattern:** When using the brainstormer agent, always do 2-3 turns via SendMessage before presenting results. Turn 1: explore + challenge. Turn 2: refine based on pushback. Turn 3: lock recommendation. Present the final synthesis to the user, not the raw back-and-forth.

Using subagents saves main context and runs cheaper models on tasks that don't need Opus.

## Documentation

`docs/` contains architecture, strategy, and design decisions. Key ones:
- `docs/o8-product-brief.md` — **Start here.** Product vision, moats, monetization, v1 scope
- `docs/company-thesis.md` — Company thesis and competitive positioning
- `docs/v1-build-plan.md` — Karpathy thread mapped to exact product requirements
- `docs/canonical-workflow.md` — Full product workflow
- `docs/system-architecture.md` — Mermaid diagram of the full system
- `docs/runtime-adapter-contract.md` — AgentRuntime interface evolution
- `docs/performance-architecture-principles.md` — Render speed, bootstrap, streaming
