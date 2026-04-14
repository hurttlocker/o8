# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is This

**o8** (formerly Cortex IDE) is a Next.js 16 + Tauri v2 desktop app — **the governance layer for autonomous engineering teams**. Approvals, audit, organizational memory, and mobile operator control across any AI provider. Claude is the orchestrator/brain; Codex is the workhorse executing tasks in worktrees. It runs two agent runtimes (Codex, Claude Code) through a universal CLI-based adapter interface, with separate desktop and mobile surfaces.

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
npm run build               # Next.js production build (webpack, not turbopack)
npm run tauri:build         # Unsigned native macOS app
npm run tauri:build:signed  # Signed (updater-ready) build, passes --features dev-mcp-plugin

# Ship (local release — bypasses CI, publishes to GitHub)
npm version patch            # bump + sync all manifests + tag (runs sync-version.mjs hook)
git push --follow-tags
npm run ship                 # build signed + upload via scripts/release.mjs

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

Two adapters: `codex.ts`, `claude-code.ts`. Both share capabilities: discover, readTranscript, launch, resume, interrupt, reviewDiffs. Codex distinguishes "owned" (IDE-spawned, full control) vs "discovered" (user terminal, read-only) sessions.

`discoverAllSessions()` runs all adapters in parallel via `Promise.allSettled`. `routeAction()` dispatches resume/interrupt to the correct runtime.

### WebSocket Server (`src/ws-server.ts`)

Separate process on port 3002 (proxied via Next.js rewrite at `/ws`). Multiplexes real-time data for mobile clients.

Channel semantics matter:
- **LOSSY** channels (`chat` deltas, `terminal` data, `pong`): intermediate messages dropped under backpressure
- **DURABLE** channels (`inbox`, `history`, `review`, `conflicts`): queued, with safety-net polling fallback (8–10s)

Backpressure: 64KB buffer limit, max 32 queued messages, 50ms flush interval.

Architecture: `Mobile ←WS:3002→ ws-server` + HTTP to Next.js API. Supervisor polls runtime inventory via direct function imports (not HTTP).

### Desktop vs Mobile

These are **completely separate codebases** by design. No shared components. Mobile (`src/components/mobile/`) is a remote control surface, not a scaled-down desktop. Desktop (`src/components/desktop/`) is the full dashboard.

### Database (`src/lib/db/`)

SQLite via better-sqlite3 + Drizzle ORM. Data dir: `~/.cortex-ide/` (override: `CORTEX_IDE_DATA_DIR`). WAL mode, normal sync, FK constraints on. Schema auto-migrates on first `getDb()` call — markers at `~/.cortex-ide/.db-migrated-v*`.

Core tables: users, api_keys (AES-256-GCM encrypted), usage_logs, subscriptions, sessions, teams, team_members, waitlist, session_outcomes (Cortex v2 ledger), lanes, approvals, watched_agents, github_*.

### Theming (`src/lib/theme/`)

CSS variable system with 60+ tokens per theme. Three themes: `light`, `dark`, `midnight`. `ThemeProvider` applies vars to `<html>` root, persists to localStorage (`cortex-theme` key). Components reference `var(--t-*)` tokens inside inline styles.

**Never hardcode rgba colors for theme surfaces.** Use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`, etc. A hardcoded `rgba(255, 255, 255, 0.56)` renders as a huge light-gray blob in midnight — see commit 929ffdf for the repo-registry sweep.

### Port resolution (`src/lib/panel/api-port.ts`)

**Never hardcode port 3001/3002.** The Tauri sidecar probes `3001-3050` (API) and `3002-3100` (WS) for free ports at startup and writes the chosen values to `~/.cortex-ide/api-port` and `~/.cortex-ide/ws-port`. All consumers must resolve the port via:

1. `process.env.O8_API_PORT` (set by sidecar)
2. `process.env.PORT` (Next server runtime)
3. `~/.cortex-ide/api-port` file (standalone MCP processes)
4. Legacy default `3001` (dev workflow)

Server-side TS: `import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port'`. MCP servers that run as standalone node processes duplicate a small `resolveApiBase()` helper because they can't import from `@/lib`.

### API security (`src/middleware.ts`)

Global Next middleware runs in Node runtime and gates these prefixes on loopback origin + bearer token: `/api/panel/`, `/api/orchestrator/`, `/api/directives`, `/api/cortex/`, `/api/runtime/`, `/api/lanes`, `/api/worktrees`, `/api/review/`, `/api/board/`, `/api/command-center/`, `/api/claude-code/`, `/api/codex/`, `/api/operator/`, `/api/setup/`.

- Loopback (`127.0.0.1`, `localhost`, `tauri://localhost`, `same-origin`) passes automatically.
- Cross-origin must present `Authorization: Bearer <ws-token>` matching `~/.cortex-ide/ws-token` exactly.
- Allowlist: `/api/setup/*` GET only, `/api/v2/auth/*`, `/api/panel/github-device/*`, `/api/panel/status` — read-only allowlist so first-run and OAuth handshakes work.
- **Never add a new route that touches agent/repo state without going through this gate.** If you need public access, put it under `/api/setup/*` as a GET-only endpoint.

### MCP servers (`src/lib/mcp/`)

Two stdio MCP servers expose o8 to Claude Desktop / Claude Code:
- `operator-mcp-server.ts` — user-facing tools: `o8_status`, `o8_send`, `o8_approve`, `o8_reject`, `o8_history`, `create_mission`, `dispatch_mission`, `get_mission_status`, `submit_review`, `approve_and_merge`, `reset_packet`, `retry_packet`, plus the `o8_view_*` webview control tools
- `cortex-mcp-server.ts` — internal tools spawned by orchestrator Claude Code sessions (fleet/issues/PRs/approvals/agents)

#### Webview control tools (`o8_view_*`)

The operator MCP server also exposes 7 tools for controlling the running o8 webview directly:

- `o8_view_screenshot` — capture the current window as PNG base64
- `o8_view_snapshot` — numbered accessibility tree for element discovery
- `o8_view_click` — click by ref or coordinates
- `o8_view_type` — type into focused element
- `o8_view_read` — visible text of the page
- `o8_view_eval` — run JS in the webview
- `o8_view_navigate` — push a new route via history.pushState
- `o8_view_wait_for` — poll until a CSS selector resolves (optional text substring match), caps at 25s

These wrap a Unix socket at `/tmp/tauri-mcp-o8-<user>.sock` exposed by the Tauri `dev-mcp-plugin` feature. Signed/prod builds always include the socket. Dev builds need `cargo tauri dev --features dev-mcp-plugin`.

The previous standalone `tauri-mcp` node bridge has been retired — the operator MCP server now owns all webview control. Only the `o8` entry remains in `.mcp.json`.

Both bundle via esbuild in `scripts/tauri-export.mjs` → `out/server/*.mjs`. The Tauri sidecar sets `O8_BUNDLED_MCP_PATH` + `O8_BUNDLED_MCP_DIR` so packaged installs launch with `node <bundled>.mjs` instead of dev `tsx` paths. Config generator at `/api/setup/mcp-config` emits the correct command per install mode.

MCP distribution: `/api/setup/claude-desktop` GET/POST writes to `~/Library/Application Support/Claude/claude_desktop_config.json` (or `~/.claude.json`) with merge-preserving logic + `.o8-backup-<ts>` sidefiles. Settings → MCP tab is the user-facing surface.

### Tauri sidecar (`src-tauri/src/lib.rs`)

The Rust shell runs pre-flight checks before spawning any Node process:
1. **Node pre-flight**: resolves `node` via login shell (zsh → bash → sh → which) so Finder-launched apps find nvm/fnm/volta. Verifies version ≥ v22. Shows native dialog (osascript/mshta/zenity) + exits on failure.
2. **Port allocation**: probes free ports, writes to `~/.cortex-ide/{api-port,ws-port}`, sets `O8_NODE_BIN`, `O8_API_PORT`, `O8_WS_PORT` env vars for children.
3. **Bundled server spawn**: `node out/server/server.js` on the picked port, plus `ws-server.mjs`, plus the optional `tauri-plugin-mcp` (gated behind `dev-mcp-plugin` Cargo feature).

`tauri-plugin-mcp` is optional — build with `cargo tauri dev --features dev-mcp-plugin` only if you want the AI-agent-driven webview testing plugin. Default builds don't need it.

### Cortex Memory Integration

`src/lib/cortex/client.ts` wraps the `~/bin/cortex` CLI binary. Three client variants: `LocalCortexClient` (exec), `CloudCortexClient` (HTTPS), `HybridCortexClient`.

### Orchestrator Architecture (April 2026 refactor)

**The Orchestrator is a TAB inside WorkspaceTerminal, not a floating tile.**

There are exactly two tabs in a fresh workspace: `Orchestrator` and `Assistant`. Both render inside `WorkspaceTerminal` via the `kind` field on `TerminalTab` (see `workspace-terminal/types.ts`). Clicking either takes over the full workspace area.

The Orchestrator tab (`workspace-terminal/OrchestratorTab.tsx`) is a three-pane layout:

```
┌──────────┬────────────────────┬──────────┐
│ History  │      Chat          │ Mission  │
│ (260px)  │  ThoughtsChatPanel │ (340px)  │
│ (toggle) │                    │ (toggle) │
└──────────┴────────────────────┴──────────┘
```

- **Left sidebar**: `OrchestratorHistorySidebar.tsx` — past orchestrator threads grouped by day, hover-reveal trash-icon delete. Collapsed by default, `cortex-ide:orchestrator:history-open` localStorage key.
- **Center**: `ThoughtsChatPanel` with `emptyStateOverride={<OrchestratorEmptyState/>}` — the empty state shows the greeting + 4 quick-action cards.
- **Right sidebar**: `ThoughtsMissionPanel` re-used as-is — Mission Control, Open Issues, Packet cards. Collapsed by default, `cortex-ide:orchestrator:mission-open` localStorage key.
- **Permission chip** (Full access / Read-only) persists per-tab to localStorage `cortex-ide:orchestrator-permission:tab:<tabId>`.

**Retired tile kinds** (do not reintroduce): `thoughts`, `mission-control`, `orchestrator-history`. The old floating tile versions were deleted: `OrchestratorChatTile`, `MissionControlTile`, `OrchestratorHistoryTile`, `orchestrator-tile-bus`.

**TILE_LAYOUT_VERSION is 4.** Any persisted layout with the retired kinds gets migrated to a plain `terminal` leaf via `migrateNode()` in `lib/tiles/operations.ts`. Bump the version if you add another breaking change.

**Data flow** — `OrchestratorDataProvider` (`components/desktop/orchestrator-data-context.tsx`) sits in `dashboard/page.tsx` and exposes `{ agents, missionState, workspaceTargets, onMissionStateChange, onLaunchPacket, draftInjection }`. The OrchestratorTab consumes via `useOrchestratorData()` — this avoids prop-drilling through WorkspaceTerminal.

**NavRail discipline** — the left nav rail no longer carries orchestrator-related launchers. The "small panels" (tile layer) are reserved for the global terminal (`contextual-panel` kind). Do not add a Lightbulb/Rocket/Clock back to the NavRail.

**Packet cards use Issues-style rows.** When a packet is expanded in Mission Control, metadata (Summary / Runtime / Repo / Branch) renders as clickable rows with uppercase labels + values + chevrons. Click to inline-edit (textarea/input) or open a floating popover (runtime/repo). No native `<select>` or `<input>` boxes in the packet card — they read as chunky bubbles against the Issues density.

### Key Files (largest, most active)

| File | What it does |
|------|-------------|
| `src/app/dashboard/page.tsx` | Main layout orchestrator. Wraps TileContainer in `OrchestratorDataProvider`. |
| `src/components/desktop/AgentPanel.tsx` | Agent fleet view: repo-grouped cards, status groups, activity feed, issues, PRs, CI, deploys. |
| `src/components/desktop/LLMChat.tsx` | Chat panel with LLM conversation (the **Assistant** tab). |
| `src/components/desktop/workspace-terminal/OrchestratorTab.tsx` | The **Orchestrator** tab — three-pane layout with collapsible History + Mission sidebars. |
| `src/components/desktop/OrchestratorEmptyState.tsx` | Empty-state greeting + 4 quick-action cards for the Orchestrator. |
| `src/components/desktop/OrchestratorHistorySidebar.tsx` | Left sidebar — past orchestrator threads with delete. |
| `src/components/desktop/SessionVisualizer.tsx` | Horizontal strip of active agent sessions, shown inside the Orchestrator tab when agents exist. |
| `src/components/desktop/thoughts/ThoughtsChatPanel.tsx` | Chat transcript + composer for the orchestrator and CLI lanes. Supports `emptyStateOverride` + `fillInput`/`sendNow` imperative methods. |
| `src/components/desktop/thoughts/ThoughtsMissionPanel.tsx` | Mission Control — framed input, Open Issues, Issues-style packet cards with inline-edit rows. |
| `src/components/desktop/Canvas.tsx` | Bottom workspace: issue viewer, transcript viewer, file viewer, timeline. |
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
- `/api/claude-code/*`, `/api/codex/*` — Per-runtime endpoints

### Library Domains (`src/lib/`)

37+ feature domains. Key ones:
- `runtimes` — Adapter registry (Codex, Claude Code)
- `runtime` — IDE session registries: `ide-session-registry.ts`, `ide-llm-chat-registry.ts`, `ide-terminal-state.ts`, `ide-surface-state.ts`, `actions.ts`, `inventory.ts`
- `llm` — LLM subsystem: `tools.ts` (tool definitions), `memory.ts` (memory management), `chat-history-store.ts` (persistent storage), `context.ts`
- `approvals` — Approval workflows for LLM actions (`store.ts`, `types.ts`, `llm.ts`)
- `workspace` — Workspace lifecycle management and persistence
- `worktree` — Git worktree management (conflicts, launch, manager)
- `board` — Task board state and types
- `cortex` — Memory recall/import client
- `db` — Drizzle schema + SQLite
- `theme` — CSS variable system
- `panel` — Panel auth (loopback host checking + token verification)
- `mobile` — Mobile-specific: inbox filter, sounds, types
- `terminal` — PTY/tmux tab state
- `connectors` — External service connectors

## Critical Rules

### NEVER
- **Never spread `...statusResult` AFTER session data in `runStatusSnapshot()`** — the `status` RPC response has its own `sessions` key that will clobber real session data from `sessions.list`. Always spread it BEFORE so our keys win.
- **Never use CSS classes** — inline styles only (`style={{ }}` props). iOS Safari reliability issue. This is permanent.
- **Never hardcode rgba colors for surfaces** — use `var(--t-bg-card)`, `var(--t-panel)`, `var(--t-input-bg)`. Hardcoded `rgba(255,255,255,0.xx)` becomes a light-gray blob in midnight theme. See commit 929ffdf.
- **Never hardcode port 3001 or 3002** — use `getApiBase()` from `@/lib/panel/api-port` (server-side TS) or `resolveApiBase()` helper (standalone MCP node processes). The Tauri sidecar picks ports dynamically and writes them to `~/.cortex-ide/{api-port,ws-port}`.
- **Never hardcode `/Users/marquisehurtt/*` paths** — use `process.cwd()`, `os.homedir()`, `process.env.HOME`, or an explicit env var. The clone-readiness audit found 15+ leaks; they've been fixed but don't reintroduce.
- **Never bypass the middleware in `src/middleware.ts`** — it gates all dangerous API routes on loopback + ws-token. If you add a new route prefix that touches state, add it to `GATED_PREFIXES`. If you need public GET access, add it to `ALLOWLIST_READ_ONLY`.
- **Never use emoji** — Phosphor icons (raw SVG) across all surfaces
- **Never use Material Design patterns** — no borderLeft accents, no MD elevation
- **Never use React icon components in Tauri webview** — neither `@phosphor-icons/react` nor `lucide-react` render correctly. Extract SVG path data from `@phosphor-icons/react/dist/defs/` and use raw `<svg>` elements. For simple actions (plus/minus), prefer HTML entities.
- **Never use dropdown overflow menus ("...")** — use inline actions with confirmation strips instead
- **Never put early `return null` before hooks** — all hooks must run in same order every render
- **Never use CSS shorthand** — use `paddingTop`/`paddingLeft`, not `padding: "8px 16px"` (React 19 warns on mixed shorthand/longhand)
- **Never throw in API routes** — return structured error responses
- **Never use `ai` SDK** — direct fetch to `/api/v2/proxy/llm` route
- **Never reintroduce the retired orchestrator tile kinds** — `thoughts`, `mission-control`, `orchestrator-history` are DELETED. The Orchestrator is a tab inside `WorkspaceTerminal` (`OrchestratorTab.tsx`). History and Mission Control are collapsible sidebars INSIDE that tab, not separate tiles, not NavRail launchers. If you need a new orchestrator surface, extend `OrchestratorTab` — do not create a new tile kind. See the "Orchestrator Architecture" section.
- **Never add NavRail launchers for orchestrator/mission/history** — the nav rail's bottom section is reserved for ports, alerts, and settings. The "small panels" (tile layer) are reserved for the global terminal (`contextual-panel`).
- **Never use native `<select>` or `<input>` inside packet cards** — packet metadata rows use Issues-style clickable rows with custom popovers. Native form controls render as chunky bubbles that break the density.

### ALWAYS
- **`npx tsc --noEmit` before every commit**
- **Respect the 800-line file ceiling** — if your changes would push a file past 800 lines, decompose first. Extract helpers, hooks, or modules before adding new logic. Layout orchestrators (`page.tsx`) and multiplexers (`ws-server.ts`) are explicitly waived.
- **Apple HIG**: 44px touch targets, 14px card radii, spring curves
- **`as React.CSSProperties`** when using vendor-prefixed or non-standard CSS props
- **Build for both runtimes** — Codex and Claude Code. The adapter interface allows adding new runtimes later.
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

See `.env.example` at the repo root for the complete reference — 40+ documented vars grouped by feature (Core, LLM providers, GitHub, Review, Cortex memory, Runtime adapters, WS/realtime, Tauri packaging, Deployments).

Most are optional. Fresh clones boot with nothing set. Specific features gate on specific vars:
- **LLM chat**: at least one of `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`
- **GitHub App auth** (higher rate limits): `GITHUB_APP_ID` + `GITHUB_APP_INSTALLATION_ID` + `~/.cortex-ide/github-app.pem`
- **Data dir override**: `CORTEX_IDE_DATA_DIR` (default: `~/.cortex-ide`)
- **Dev ports**: `PORT`, `WS_PORT` (overridden at runtime by Tauri sidecar port probing)

`src/lib/github-app.ts` returns null when GitHub App env vars are missing — there are no hardcoded fallbacks. `src/lib/review/workspace.ts` skips the active-review feature entirely when `CORTEX_IDE_ACTIVE_REVIEW_ISSUE` is unset.

## Git Practices

- All work on `main` branch (no feature branches — rapid iteration mode)
- `npx tsc --noEmit` before every commit
- `git push origin main` after each commit

## Shipping (dev prod mode — the daily driver loop)

The user daily-drives the **installed** production app at `/Applications/o8.app` and develops *through* it (via Claude talking to the bundled `o8_view_*` MCP tools on the operator server). Every code change needs to reach the installed app through an auto-update, not through `cargo tauri dev`.

### The loop

```bash
npm version patch              # 0.1.X → 0.1.X+1 — sync-version.mjs hook updates
                               # package.json + src-tauri/tauri.conf.json +
                               # src-tauri/Cargo.toml in a single commit, then
                               # npm creates the v0.1.X+1 tag
git push --follow-tags          # send commit + tag to origin
npm run ship                    # cargo tauri build with signing key +
                               # dev-mcp-plugin feature, then
                               # scripts/release.mjs creates the GH release
                               # and uploads all 4 assets
```

The user's installed `o8.app` sees the new version via the `UpdateBanner` component (polls every 30 min or on launch), downloads the signed `.app.tar.gz`, verifies the minisign signature against the pubkey in `tauri.conf.json`, extracts, replaces `/Applications/o8.app`, and relaunches.

### Why local instead of CI

GitHub Actions macOS runners failed because of billing. Local `npm run ship` takes ~2–4 min vs ~6 min CI and costs nothing. The CI release workflow (`.github/workflows/release.yml`) still exists as a fallback — it triggers on `v*` tags and uses the same `TAURI_SIGNING_PRIVATE_KEY` secret. If CI billing gets fixed, the workflow will auto-publish parallel to the local script (harmless — `gh release create` in the script errors cleanly when the release already exists, use `--clobber` inside the script to replace assets).

### Signing

`~/.tauri/cortex-ide.key` is the minisign private key. Its pubkey is embedded in `tauri.conf.json` under `plugins.updater.pubkey`. DON'T rotate without re-signing every future release — the installed app will refuse the update if the signature doesn't validate.

### o8_view_* webview tools (lets Claude drive the installed app)

The production build includes the `tauri-plugin-mcp` Rust crate via the `dev-mcp-plugin` Cargo feature (always-on now in `tauri:build:signed`). On launch it opens a Unix socket at `/tmp/tauri-mcp-o8-<user>.sock`. The **operator MCP server** connects to that socket and exposes 7 tools with `o8_view_*` verbs (screenshot, snapshot, click, type, read, eval, navigate).

`.mcp.json` at the repo root registers only the `o8` operator MCP server. Any new Claude Code session that opens this directory picks it up automatically and the webview tools appear under `mcp__o8__o8_view_*`.

**Known seam issue:** `o8_view_eval` and `o8_view_snapshot` sometimes time out when the webview's JS main thread is busy (streaming orchestrator response, Next.js hydration). `o8_view_screenshot` and `o8_view_navigate` always work because they run on the Rust side. Work around by taking screenshots + clicking via raw coordinates.

## Theme System (current state, April 13)

**Two shipping themes: `light` and `midnight`. Dark was removed** — legacy users on `dark` auto-remap to `midnight` via `LEGACY_THEME_IDS` in `src/lib/theme/context.tsx`.

### Shape of both themes

Both use **translucent glass chrome over the macOS vibrancy backdrop**. The `ThemeProvider` forces `--t-chrome`, `--t-bg-gradient`, `--t-chrome-nav` to `transparent` in Tauri for any theme — the difference between light and midnight is the RGBA tint of the *other* panel tokens that paint on top of the vibrancy.

| Surface | Light | Midnight |
|---|---|---|
| Chrome (vibrancy-passthrough) | `transparent` | `transparent` |
| `--t-panel` | `rgba(255, 255, 255, 0.58)` | `rgba(62, 68, 78, 0.36)` |
| `--t-bg` | `rgba(250, 251, 253, 0.62)` | `rgba(22, 25, 30, 0.56)` |
| **Workspace / chat / terminal** | **solid `#ffffff`** | **solid `#1a1e24` / `#16191e`** |
| `--t-text` | `#0f172a` (dark) | `#e8ecf2` (light) |

### The workspace/center is always solid, never glass

`--t-chat-surface-bg`, `--t-canvas-bg`, `--t-terminal-bg` are pinned to solid colors in both themes. The LLM chat panel in `LLMChatLayout.tsx` paints `background: var(--t-chat-surface-bg)` over itself, so the center content area never bleeds the vibrancy. That's intentional — code/chat/terminal text needs a stable paper surface.

### Macos vibrancy material

`src-tauri/src/lib.rs` currently applies `NSVisualEffectMaterial::HudWindow` unconditionally at startup. HudWindow is dark, so light-tinted RGBA panels look silver-grey rather than white. This is a known tradeoff — a dynamic material swap (Rust side, via a theme-change event) would let Light use `NSVisualEffectMaterial::Sidebar` or `HeaderView` (adaptive or light-only).

### Open visual work (for a new agent picking this up)

**User's immediate ask (April 13 evening):**

> In Light mode, the background of the white workspace is correct. But the buttons in the left sidebar and right Changes panel are hard to read — they should be transparent (glass) with white font. The vibrancy-bled chrome reads darker than the workspace, so button labels need to flip to white text ON the dark glass chrome while the workspace keeps dark text.

This is a two-text-palette problem. Light mode currently uses a single `--t-text: #0f172a` for everything, which is correct for the white workspace but wrong for the darker glass chrome overlay.

**Proposed fix (unvalidated — verify visually with the user before shipping):**

1. In `light` theme, leave `--t-text-*` as dark (they're read by components inside the white chat surface)
2. Add or repurpose **chrome-specific text tokens** that are light-colored in both themes:
   - `--t-chrome-text` / `--t-chrome-text-secondary` / `--t-chrome-text-muted`
   - Light: near-white values (`#ffffff`, `rgba(255,255,255,0.78)`, etc.)
   - Midnight: existing `--t-text-*` values
3. Update sidebar (`NavRail / WorkspacesPanel`), header (status bar, command palette), footer (port chips, issue badges), right panel (Changes / Commit) to reference `var(--t-chrome-text-*)` instead of `var(--t-text-*)`
4. `LLMChatLayout.tsx` already overrides `--t-text` to chat-surface-text inside the chat card — make sure that override still wins

Alternative path: swap the vibrancy material to something lighter (`NSVisualEffectMaterial::Sidebar`) for light theme via a Rust-side event. Cleaner long-term but needs more Rust plumbing.

**How to iterate:** the installed app has the `dev-mcp-plugin` Cargo feature enabled. Use `mcp__o8__o8_view_screenshot` after each theme tweak. Ship with `npm run ship` after each change — takes ~2 min to build + upload + auto-update. Don't rely on `cargo tauri dev` — the user daily-drives the prod build so that's where the feedback loop lives.

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

**Brainstormer pattern:** The brainstormer does all 3 turns internally (explore, self-challenge, lock) in a single invocation. It returns a structured response with Turn 1/2/3 headers. Present only the final locked recommendation to the user. If you want to push back on the result, spawn a new brainstormer with the prior recommendation as context.

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
