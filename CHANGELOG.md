# Changelog

Development activity for o8 — the governance layer for autonomous engineering teams.

We ship high-signal entries only (features + performance wins). Bug fixes, refactors,
and internal chores live in the private engineering log.

---

## 2026-04-16

- `e336cd0` feat(cloud): standalone worker CLI reference implementation
- `781f687` feat(lane): route remote-customer merges through merge gate
- `1cf339c` feat(settings): Workers tab UI + worker tokens API + feature-flag helper
- `dfd061f` feat(dispatch): inject learned rules into packet prompt
- `5720619` feat(dispatch): learned-rules promotion/demotion cron
- `2d58081` feat(cloud): CustomerWorkerTransport + register remote-customer adapter
- `7fdbd07` feat(cloud): worker poll + event endpoints with token auth
- `bd05bb2` feat(db): worker_tokens + worker_runs + worker_events tables
- `f58ed2f` feat(dispatch): dispatch_rules table + record from lane merge events
- `5517075` feat(runtimes): scaffold remote runtime protocol types
- `f9bf7ef` feat(sidebar): replace 'Idle' label with 3-word task summary
- `19b5255` feat(governance): autonomous decomposition pipeline

## 2026-04-15

- `7d08afa` feat(supervisor): mechanical project rules rule enforcement at post-completion
- `ae92dce` feat: add design mode overlay
- `c18aecf` feat: branch picker wizard in packet dispatch
- `6f5fce1` feat(delegate): synthesize packet shell so governance tools find the lane
- `d6301dc` feat: persist orchestrator plan text in chat history
- `c850fea` feat: auto-capture lane review screenshots
- `5cacf22` feat: add external orchestrator mcp servers
- `4fd3a66` feat(orchestrator): Apple-style tool call cards + sticky working bar

## 2026-04-14

- `857df13` feat(orchestrator): export thread to markdown (closes)
- `1dba6aa` feat(orchestrator): anti-patterns section + final-message format doctrine
- `2cdb597` feat(orchestrator): pin to Opus 4.6 + rewrite system prompt for single-turn execution
- `1037398` feat(lane): reap idle abandoned lanes + safety guard main tree
- `c8d18e0` feat(history): archive tab in orchestrator history drawer
- `14badaf` feat(workspace): merged read-only banner on retired chat tabs
- `1ae6852` feat(lane): hide sidebar cards + packets bound to archived lanes
- `a961033` feat(lane): auto-wrap manual runtime launches in a governance lane
- `6f83e71` feat(mcp): add o8_view_wait_for for polling UI readiness
- `fcf31aa` feat(lane): auto-archive stuck reviewing lanes + retire standalone native shell-mcp bridge
- `d772218` feat(mcp): bundle o8_view_* webview tools + session picker + UI polish
- `2023d61` feat: add timeline toggle to appearance settings
- `4786795` feat(theme): chrome-surface sweep + light blue accent + add-repo redesign

## 2026-04-13

- `4af65f9` feat(theme): chrome-surface scope for light mode glass buttons
- `9a5948d` feat(theme): ship Light + Midnight only, light becomes glass chrome
- `3b1ee21` feat(mcp): ship native shell-plugin-mcp with the production build
- `31ea629` feat(ship): local release script + ship npm scripts
- `fd1fe3c` feat: Operator live fallback notice + Plan/Code permission chip
- `4d6394d` feat: o8 Operator + drop legacy provider keys + agent runtime CLI runtime

## 2026-04-12

- `e426aa2` feat: add dogfood-audit agent — 6-agent parallel product validation
- `2f18524` feat: thinner fonts + desaturated diff in Changes panel
- `1f41c0f` feat: unified user bubbles across all chats — subtle tinted pill
- `3d5cfe0` feat: thinner orchestrator chat text
- `9bbe71d` feat: roll Plus Jakarta Sans as the app-wide typeface
- `1d62ec1` feat: add Satoshi, Outfit, Manrope to typography specimen + match app sizes
- `58401ed` feat: add /text typography specimen page for font comparison
- `c392a17` feat: agent click scopes workspace panel to agent's worktree
- `a95d6d8` feat: aggregated Issues panel shows all repos grouped by sections
- `5e3d2c8` feat: repo alignment gesture — click repo name aligns whole app
- `38bc7c1` feat: multiple repos can be expanded simultaneously in sidebar
- `8adcc05` feat: fleet orchestrator UI — repo focus indicator + sidebar status
- `cc1eef1` feat: orchestrator system prompt is fleet-aware across all repos
- `ee4054d` feat: drag-to-reorder workspace tabs
- `ec5140a` feat: session rows match orchestrator row layout
- `3eba2a8` feat: rename CLI session tabs from 'Assistant' to 'Agent'
- `8d937cd` feat: orchestrator tab is visually elevated and un-closeable
- `d507389` feat: agent session tabs show repo + runtime instead of "Assistant"
- `f8c4889` feat: apple squircle corners on right panel (O8 + workspace review)
- `0a98f23` feat: move permission + issues controls into composer toolbar

## 2026-04-11

- `c14077c` feat: analytics apple pass + empty state respace + element picker iframe-proxy
- `e5948b7` feat: midnight-aware terminal theme + navrail/titlebar consolidation
- `ef1ff62` perf: gate headless sprint loop on queued packets
- `ec9d232` perf: slim ws-server + lazy-spawn dashboard PTY
- `fefe98a` feat: orchestrator becomes a workspace tab with integrated history + mission

## 2026-04-10

- `df128de` feat: mission dispatch echo + plan-mode banner in orchestrator tile
- `43c8467` feat: NavRail launchers for Mission Control + Orchestrator History
- `0ee546e` feat: side-effect-class tool rendering + cross-tile orchestrator bus
- `89386ed` feat: orchestrator/mission/history as tile-native components
- `98d7ef5` feat: thread permissionMode through sendToOrchestrator
- `3128725` feat: production hardening
- `aed9b50` feat: Node pre-flight + dynamic port allocation

## 2026-04-09

- `1d16f4e` feat: AI provider Desktop auto-register + setupComplete schema fix
- `04e4c36` feat: MCP production hardening — auth, config distribution, bundling
- `e0e7074` feat: add shared token formatter
- `92ddffd` feat: o8 v2 observability — Ledger + Preview tabs in Memory view

## 2026-04-08

- `c8c14ef` feat: o8 v2 Phase 1 — directives store + session ledger + API
- `0bd6a4c` feat: @-mention file suggestions on mobile chat compose
- `69be168` feat: shared useFileDrop hook
- `6f94da5` feat: enriched approval cards
- `79d7bc3` feat: pre-dispatch file overlap gate
- `48a878f` feat: expandable detail rows in O8 Activity pane — click to expand inline context
- `11bd450` feat: thinking effort control
- `6dfb0e5` feat: merge gate enforcement
- `ff56a19` feat: specialized mobile tool call cards — diff, shell, read, search

## 2026-04-07

- `f3ccb7a` feat: mobile CLI chat backend
- `2a8f9a1` feat: CLI chat backend
- `95f139c` feat: o8 Assistant rebrand
- `0398f52` feat: add OpenRouter + xAI providers + key validation on save
- `a6b95fe` feat: inline missions

## 2026-04-06

- `1425daa` feat: commit viewer in O8 Changes tab — click commit to review inline
- `98f5fc5` feat: click worktree to open agent transcript
- `c926c6f` feat: collapse tool calls in transcript bubbles
- `18e0d58` feat: Activity tab in O8 Panel — unified activity feed
- `5479702` feat: compact activity badges on repo cards for ambient awareness
- `f5eebb2` feat: show conversation preview in chat tab labels instead of generic "Chat"
- `6e361fc` feat: show agent runtime/AI provider brand logo in chat tab headers
- `15d20d7` feat: use official agent runtime + AI provider brand logos across all surfaces

## 2026-04-05

- `6bc9ebd` feat: add runtime icons to session agent rows + collapsed branch badges
- `9b5c03c` feat: replace CX/CC text badges with agent runtime and AI provider SVG logo icons
- `4e193f7` perf: extract DashboardInner state into grouped context hooks
- `61c8145` perf: native shell IPC for SQLite endpoints
- `4ae7f87` perf: virtualize transcript list for long agent sessions
- `a6282dd` perf: lazy-load heavy Canvas tab components + o8TaskBoard
- `7a4da55` perf: deduplicate workspaces + inbox API calls on initial load
- `052980c` perf: eliminate transcript render storm + 11 more polls → WS-driven + API dedup
- `5916e09` perf: native shell IPC commands for hot-path data reads — bypass HTTP stack
- `312262c` perf: WS-driven invalidation for 18 polling loops + React.memo on 31 components (,)
- `babfed3` perf: replace 2 polling loops with useReactiveQuery
- `ce00a34` feat: TanStack Query + WS event bridge for reactive data layer
- `d9206f5` feat: MCP dispatch DX overhaul
- `b7ccc19` feat: truthful worktree status + cleanup stale worktrees
- `83743d3` feat: click worktree → open agent transcript in canvas ( v1)
- `1ad8848` feat: thinking indicator + faster polling for active agent sessions
- `2bd6c5b` feat: port hover popover + open ports in O8 browser tab
- `23a33db` feat: open activity commits in O8 changes pane
- `376f426` feat: instant PR cache invalidation after merge/approve/request changes
- `e833312` feat: inline file diffs + merge conflict badge in O8 PR review
- `04a5a76` feat: PR count badge on repo card — click to open O8 PRs list
- `067dd2f` feat: PR list view in O8 panel — all open PRs on one page
- `da722f7` feat: PR review tab in O8 panel — replaces canvas PR viewer
- `0601aad` feat: collapsible root files section in O8 file tree
- `a749385` feat: editable file viewer in O8 Files tab — competing product-style editing
- `08a5f97` feat: file browser in O8 panel Files tab — competing product-style split layout
- `88e94cd` feat: dispatch pipeline hardening
- `779d9a4` feat: wire Edit with AI + Open Source callbacks in O8 element panel
- `65d73b1` feat: visual element selection panel for O8 Browser tab

## 2026-04-04

- `f454b6f` feat: element picker bridge + source mapper API + rate limit fixes
- `5d6b8bd` feat: O8 Browser tab — wire LocalhostPreviewTabs into O8 panel
- `d07fd20` feat: O8 panel Changes tab — git status + inline diff + tab bar
- `e55df29` feat: O8 panel
- `cce11bb` feat: mobile WS reconnect with exponential backoff + approval recovery
- `f656a6e` feat: startup lane reconciliation
- `46a3316` feat: startup lane reconciliation
- `0b84a77` feat: GitHub intake pipeline — issue assignment to plan approval
- `65272fa` feat: persist runtime session costs to usage logs
- `b402264` feat: o8 agent safety hooks
- `9dc4866` feat: mobile repo picker for multi-repo chat
- `f6777fa` feat: repo-scoped tool execution + repos API

## 2026-04-03

- `eaf7ae5` feat: apply file edits on approval approve
- `53c82c1` feat: add github tool for AI provider — gh CLI access
- `88140fa` feat: expand shell allowlist — npm, npx, node, cargo
- `8bcba20` feat: add create_file tool for AI provider
- `b673d36` feat: syntax-highlighted tool output — expand shows real code colors
- `421cab7` feat: Apple-style collapsible tool call cards
- `bc512cb` feat: AI provider tool execution backend
- `4f7fe6d` feat: compact model selector + fix theme toggle in settings
- `e3c6562` feat: restore light mode with proper theme toggle
- `9e18da3` feat: tool call card renderer components
- `9af3972` feat: tool call SSE protocol types and parser
- `e28fcf3` feat: theme-aware markdown renderer + light mode code blocks
- `898d555` feat: rebrand mobile shell for o8
- `dea5185` feat: rebuild mobile approvals and sidebar surfaces
- `8b4199f` feat: rebuild mobile approvals and sidebar surfaces
- `fcd91ca` feat: replace custom mobile chat with @assistant-ui/react Thread
- `9cce975` feat: build mobile assistant-ui thread chat
- `d3f045f` feat: mobile settings view + decompose monolithic client into focused modules
- `e89b6a6` feat: mobile redesign
- `289f3a0` feat: mobile settings view + decompose monolithic client into focused modules
- `0576fce` feat: mobile settings view + decompose monolithic client into focused modules
- `af1a715` feat: mobile settings view + decompose monolithic client into focused modules
- `3b7046b` feat: mobile settings view + decompose monolithic client into focused modules
- `b44386f` feat: mobile settings view + decompose monolithic client into focused modules
- `9ebbc38` feat: add mobile settings view to glass sidebar

## 2026-04-02

- `17f58ba` feat: full glass input field + glass send button + scroll-to-bottom arrow
- `a4e0d28` feat: glassmorphic buttons
- `75aa5d2` feat: collapsible code blocks with diff coloring and file path labels
- `ec45fa7` feat: TTS play button on assistant messages + AI provider-style input bar
- `c232719` feat: starred + recents sections in sidebar, revert dots back to long-press
- `ca8ad50` feat: long-press context menu on chat list — star, rename, delete
- `d63d217` feat: AI provider-style chat list view
- `500dc19` feat: AI provider-style message rendering + mobile markdown for code blocks
- `8763c40` feat: wire mobile chat to real chat history store + conversation list in sidebar
- `7a1aef0` feat: AI provider-style sliding sidebar + AI provider chat on mobile
- `3c40bb8` feat: add npm run tunnel for remote mobile access via Cloudflare
- `3b1c52c` perf: prefetch mobile inbox on server
- `a6aed2a` perf: break route barrel imports
- `ba66251` perf: switch dev to turbopack and lazy init db
- `14a417c` feat: bound onAgentCompletion retry loop
- `7d82733` feat: add attempt learning persistence
- `acb9bb3` feat: add low-risk auto-approve policy
- `998b96e` feat: add packet self-review confidence gate
- `56be609` feat: objective exit criteria
- `471225d` feat: compact Apple-style dropdown menu, no full-screen overlay
- `bc19c54` feat: AI provider-style tool cards in mobile chat
- `4228c8b` feat: organize mobile sessions by type — Chats, Sessions, Missions
- `84f7942` feat: warm grey + light beige palette across all 30 mobile surfaces
- `5631e6c` feat: slim compose bar
- `73ba856` feat: in-process mutex on orchestrator-state.json
- `4b610bb` feat: merge conflict escalation via approval card
- `1681823` feat: persist supervisor watch state to SQLite
- `dc3b635` feat: orchestrator session health monitor — 90s timeout + auto-recovery
- `77a08e4` feat: persistent SQLite-backed review queue
- `32fa1ce` feat: inline mission creation — no GitHub dependency
- `6481fce` perf: mobile page is now client-only — zero server-side bootstrap
- `9499529` perf: cap mobile bootstrap to 200ms budget — don't block on runtime discovery
- `294efd5` perf: mobile optimization
- `79698ce` feat: copy AI provider mobile session list — clean rows, status groups, FAB
- `bf22b7d` feat: mobile new chat — launch LLM session from phone
- `7da466a` feat: mobile wave 4
- `c726097` feat: purge 4,277 lines of remodex CSS + remaining className from mobile

## 2026-04-01

- `d9e2df4` feat: mobile waves 2+3
- `e5b7819` feat: mobile wave 1
- `276c93b` perf: P1 bundle + network optimizations
- `a648a89` perf: P0 performance fixes
- `e161191` feat: wire recommendMergeOrder() into merge pipeline
- `56443ba` feat: merge gate file size block + operator override
- `a9961db` feat: add FILE_SIZE_WAIVERS for layout orchestrators and multiplexers
- `e7dd4b3` feat: skeleton map file size check at dispatch time
- `5122754` feat: InfinityGlow animated status indicator for agent cards
- `551e995` feat: FTUX progressive feature reveal
- `43dd538` feat: FTUX first-merge celebration state
- `366bd6f` feat: FTUX mobile QR prompt
- `34f9348` feat: FTUX First Mission Card contextual CTA
- `932ee1c` feat: FTUX empty states for all dashboard panels
- `bd6c7c8` feat: FTUX warm dashboard state
- `23b1bdb` feat: FTUX personalized chat greeting
- `2bba0bf` feat: lane lifecycle WebSocket channel
- `b79ae61` feat: lane lifecycle WebSocket channel for real-time status streaming
- `0dd778d` feat: migrate approval store from JSON to SQLite
- `3b8deb9` feat: migrate approval store from JSON to SQLite

## 2026-03-31

- `4f26174` feat: migrate lane registry from JSON to SQLite — kill cross-process clobber
- `fd0baca` feat: sprint 6 wave 3
- `a18bc0a` perf: sprint 6 wave 2
- `e3321db` feat: supervisor fleet coordination
- `67d7083` feat: route Audit Log to workspace tab instead of Inspector panel
- `0386c4b` feat: sprint 5
- `72ddf13` feat: sprint 4
- `9fb9baa` feat: sprint 3
- `2659285` feat: sprint 2
- `ff3a21c` feat: structured multi-file diff in approval review gate
- `fe2a36d` feat: supervisor completion triggers lane review transition
- `9eb53b0` feat: agent runtime PreToolUse hook script for policy enforcement
- `df5857f` feat: one-shot send-as-task from ThoughtsCard chat
- `f388970` feat: server-side packet auto-dispatch loop
- `24173f2` feat: integrate native shell-plugin-mcp for native app automation in dev builds
- `3e409e6` perf: JSONL tail-reads, cache-first actions, fingerprint optimization, sleep removal
- `947b47a` perf: strip JSON pretty-printing from MCP server responses

## 2026-03-30

- `a58cd34` feat: native shell vibrancy polish, operator bridge fix, ghost session eviction, right panel cleanup
- `f008f58` feat: operator MCP bridge — agent runtime as o8 control surface
- `7644e08` feat: workspace UI overhaul
- `125caca` feat: UI polish pass

## 2026-03-29

- `52b9ba3` feat: o8 brand mark — three-circle logo in accent blue
- `b1507b5` feat: orchestrator loop — plan, delegate, review, approve
- `234f8c0` feat: governance engine
- `8b97308` feat: refine o8 product brief from 3-turn brainstormer session
- `2776758` feat: add brainstormer agent (Opus) with multi-turn delegation pattern
- `75c90b2` feat: add REVIEW.md, agent delegation table in project rules, update agent descriptions
- `ca15b5c` feat: add o8 product brief, update project rules with orchestrator model, create subagents
- `6c5d722` feat: scrollable workspace lane tabs with transparent arrow overlays
- `cf6807e` feat: tab scroll arrows, tool cards in Thoughts, right panel defaults to review
- `df8bff5` feat: workspace tab shows issue context + diagnostics settings tab (,)
- `4a09026` feat: one-click issue launch icon + lane-scoped review rail (,)

## 2026-03-28

- `6fc1e9c` feat: add orchestrator MCP server, delegation tools, and agent supervisor
- `281a490` feat: add GitHub issues to ThoughtsCard Mission Control

## 2026-03-27

- `463ff8d` feat: add translucent desktop dark mode shell
- `aac8e09` feat: harden workspace shell and terminal sessions
- `5c76535` feat: add o8 board and restore system-wide timeline
- `578e411` feat: move repo selection into workspace headers

## 2026-03-26

- `24b6ae1` feat: fix branch-scoped review flow
- `c0eacdb` feat: turn workspace side panel into repo companion surface
- `6cf89a7` feat: route repo surfaces into workspace tabs

## 2026-03-25

- `ec9aee4` feat: tighten workflow lifecycle and operator recovery
- `0981e99` feat: refine desktop dark mode theme
- `39c7bb5` feat: migrate ide to fact-backed o8 recall
- `153b76e` feat: enrich workspace cli chat parity
- `2f2b0fc` feat: polish timeline and workspace chat surfaces
- `bf8d4e8` feat: scope agent surfaces to ide sessions
- `ca06e24` feat: route workspace launches and github flows through broker

## 2026-03-24

- `eab62fb` feat: ship github app broker foundation

## 2026-03-23

- `d655dab` feat: Unified ContextualPanel — canvas tabs merged into bottom panel
- `a22ec01` feat: Drop bundled Node (prerequisite) + bundle memory binary
- `5bb7f32` feat: WS server bundled in native shell app — terminals + chat work in production
- `36cade2` feat: GitHub App authentication — 5,450 req/hr, auto-refreshing tokens
- `1111c6e` feat: GitHub PAT support + config lives in ~/.o8-ide/
- `c5085de` feat: Bundle Node.js inside the app — zero-config for users
- `a9233f8` feat: Standalone server bundling for native shell — real distributable app
- `41f1f02` feat: Inline edit
- `658912f` feat: 'Environments' filter in files dropdown — quick access to .env files
- `0d8a736` feat: Inline AI widget

## 2026-03-22

- `39ee35a` feat: Tab autocomplete — AI ghost text suggestions while typing
- `20074d8` feat: Cmd+E inline AI edit
- `e813ed4` feat: Resizable files panel — drag handle between files and activity
- `67887fd` feat: Monaco Frost v2
- `c9938b4` feat: Monaco 'o8 Frost' theme — icy light blue editor
- `6ecb9fc` feat: Monaco Editor v3 — full IDE-grade file editing
- `96449e5` feat: File editor v2
- `dca2823` feat: Inline file editor with Cmd+S save + files default to Changes view
- `048d303` feat(branding): add o8 logo component + concept assets
- `610d71a` feat: In-app update banner + landing page + version sync
- `3866ea4` feat: native shell updater + GitHub Actions release workflow

## 2026-03-21

- `d98a2ae` feat: add sidebar runtime capability layer
- `9eaeb61` feat: refine sidebar approval polish
- `50541b1` feat: polish sidebar approvals and file actions
- `7f4399c` feat: polish sidebar file actions
- `40d53b5` feat: add sidebar source actions
- `9002c69` feat: unify sidebar active turn surface
- `51e2820` feat: show sidebar web source links
- `9e8e44c` feat: enrich desktop sidebar source context
- `6347fa0` feat: refine desktop sidebar runtime turns
- `0bbef26` feat: Conflict Resolution UI in Memory settings tab
- `7acca95` feat: polish desktop sidebar runtime chat
- `05d0442` feat: add intent board v1
- `6e79944` feat: unify desktop thoughts and sidebar chat rendering
- `c1af442` feat: Codebase seeding engine — solve cold start for new users
- `78c8fc8` feat: Unified chat send route + type fixes
- `3714eb1` perf: WebSocket RPC replaces CLI fallback — agents load in <500ms
- `b6f3b5d` feat: First Launch Setup Wizard — blue glass onboarding flow
- `7097222` feat: Setup detection + config API for first-launch wizard
- `57c08ba` feat: Graceful degradation when gateway unreachable
- `0ef0b44` feat: Production polish
- `af7c99c` feat: Blocklist guard for public changelog + project rules rule

## 2026-03-20

- `51cb0bb` feat: Chain-of-thought wired for all three providers
- `248dbb6` feat: context-aware recursive compaction — three-pass smart compression
- `3a510e6` feat: project rules
- `3514bbf` feat: Chat compaction
- `cf171d8` feat: File system tools
- `698ce99` feat: Terminal command tool with three-tier safety + editable approval
- `2e69153` feat: Chat-optimized recall — structured facts over raw chunks
- `84e3417` feat: Phase B
- `d5eea79` feat: memory settings
- `18bead7` feat: memory settings tab — configure models, view stats
- `44cb6d5` feat: memory recall — Phase A
- `fa565a2` feat: Steve Jobs polish — 5 UX refinements for LLM chat
- `740c2ef` feat: Unified input container — model picker moves to bottom toolbar
- `4554694` feat: GitHub tools for LLM chat
- `40a9b69` feat: Syntax highlighting, thinking text style, citation hover cards
- `f6e81b5` feat: Chat history sidebar — search, star, open in new tab
- `8aa2868` feat: Streaming code highlights, keyboard shortcuts, conversation forking
- `b0e064f` feat: Inline citations, slash commands, Run in Terminal
- `09e2f7b` feat: Code block actions — Apply to File + Open in Canvas
- `49515e0` feat: Chain of Thought — collapsible reasoning visualization
- `c1a749f` feat: Smart follow-ups + beautiful empty state onboarding
- `6350e48` feat: Phase 3 — Tool use with live indicators + sources
- `87387fa` feat: Edge TTS voice playback with animated player
- `e8f6b5e` feat: AI provider Desktop-style message action bar + proxy logging
- `3af4c3d` feat: Chat persistence + mermaid error isolation
- `b6f2fcb` feat: Full image support
- `9a2ef51` feat: Rich markdown renderer for LLM Chat
- `ebc5898` feat: LLM Chat Phase 1+2 — workspace context + @file attachment
- `654b36e` feat: Add all latest AI provider models (3.1 Pro, 3 Pro, 3 Flash)
- `dba630f` feat: configuration settings tab
- `a2571da` feat: LLM Token Relay — provider proxy with metering
- `73cd178` feat: LLM Chat v1 — standalone model access panel
- `829b2ac` perf: GitHub API caching + worktrees auth fix across all routes
- `73112b2` feat: GitHub OAuth sign-in — user auth for monetization
- `305e857` feat: User database schema — foundation for monetization
- `68b59ac` perf: Kill scroll jitter — remove per-frame CSS recalculation
- `7b675e6` feat: client abstraction — Local/Cloud/Hybrid
- `c844b85` feat: Tier 2+3 intelligence layer

## 2026-03-19

- `5701631` feat: Repo switcher for Issues & PRs + deeper chat history
- `d25c498` feat: Issues & PRs combined page + collapsible agents + deploy
- `52db245` feat: Issues + Deploy Status + CI on mobile — monitoring & deciding
- `4ba2f2e` feat: land realtime control plane and shell-first render path
- `26afd0c` feat: Memory page
- `4ce4c01` feat: Tap-to-reveal message actions + Telegram-style photo grids
- `d5f9fba` feat: Dark mode
- `f6fd593` feat: Tier 1 UX
- `144a5f5` feat: Smooth crossfade animation between expanded header and compact pill
- `c27c972` feat: Hide RuntimeBar when keyboard is up — clean compose
- `18e7056` feat: Auto-grow input + RuntimeBar at true bottom + frosted status bar
- `1ac71b6` feat: Compaction indicator on mobile chat — matches desktop ThoughtsCard
- `45175e5` feat: Header collapse-to-pill + repo/branch/diff in bottom footer
- `797df06` feat: Costs page
- `e728c1d` feat: Settings + PR Reviews in Activity + panel status APIs
- `21413a2` feat: Notifications + PR Review from mobile
- `f7c7f5f` feat: Activity Feed + Launch-to-chat + Fleet → Agents rename
- `e80ca9c` feat: Launch Agent — fire agents from mobile
- `de47c49` feat: Fleet View — Apple-level agent dashboard for mobile
- `ec02c8a` feat: Glass slash commands on mobile — frosted popover matching desktop
- `90e6be6` feat: Mobile nav → top-right hamburger dropdown + Thinking X-ray on mobile
- `8c5b1e9` feat: Speed Dial navigation — floating menu like Mister Copy Trade
- `77f0dc0` feat: Thinking X-ray — live window into agent reasoning
- `aadb623` feat: ThoughtsCard Apple pass

## 2026-03-18

- `bb31b56` feat: Slash commands + glass attach popover in workspace chat
- `e3bfe46` feat: Chat V2 pass 2 — model/thinking, search, media button
- `7c85af6` feat: Chat V2
- `8478ec0` feat: competing product-style compact agent cards + always-visible running agents
- `e6fb735` feat: Add agent runtime + agent runtime to Open In dropdown
- `a6326d5` feat: Open In button
- `a9ee654` feat: Global Repo Context Bar — first-class repo selector above tabs
- `7506475` feat: Workspace Chat V1 — full chat tabs alongside terminals
- `511de9f` feat: Dedicated Checks tab on PR viewer — competing product-style CI status
- `cbaafa8` feat: Files tab — Changes filter dropdown
- `dba6c6f` feat: Close remaining workspace gaps
- `7f3e7cd` feat: Branch switching from panel — git checkout with dirty check
- `8742abf` feat: Running indicator on collapsed repo card
- `b1ee78c` feat: Dev server launch from repo card — one-click Run/Stop
- `f26ed10` feat: Port preview pane — in-IDE iframe via proxy
- `5d1fba5` feat: Agent ↔ Branch association — bidirectional linking
- `91d57d8` feat: First-class ports in NavRail — auto-detect + grouped display
- `73caa0d` feat: Branch management — create, delete, cleanup
- `2181b75` feat: Optional worktree launch + stale branch detection (,)
- `e431c0a` feat: Expandable repo cards — branch list with worktree indicators
- `ad609f3` feat: Colored file icons + repo-aware file tree
- `8a4eaa8` feat: PR Review opens in canvas + remove Issues/PRs/CI tabs
- `629cc42` feat: Repo-scoped Activity
- `f69959e` feat: Repo-aware Activity feed — selector, agent-scoped, PR merge banner
- `0c3133a` feat: Activity feed
- `0704618` feat: Unified Activity Feed — Apple-grade timeline with GitHub data
- `9c726d5` feat: Show all main agent surfaces + smart cron collapsing + fleet display setting
- `096f11e` feat: Pin main agents + collapse cron sessions into single card per agent
- `935e9ea` feat: Stall detection for launched agents — 5min silence triggers warning

## 2026-03-17

- `fd5b95b` feat: Proxy localhost previews to strip frame-busting headers
- `dc767c4` feat: Agent lifecycle
- `4ed8d0d` feat: Live localhost preview
- `34dbbbc` feat: Live activity dots + elapsed time on terminal tabs
- `0778301` feat: Terminal tab persistence — tabs survive app restarts
- `796e105` feat: Inline images rendered as HTML — bypass xterm IIP entirely
- `c77d971` feat: Inline image rendering
- `0adbabb` feat: Inline image rendering in terminal — Sixel + iTerm2 IIP support
- `c4c521b` feat: Auto-register folders opened via picker — shows as Recent next time
- `c3b0f1f` feat: Native folder picker
- `83d8063` feat: Open folder picker — launch CLI agents in any directory
- `457ff44` feat: Two-step CLI picker with repo selection ( foundation)
- `c7f5930` feat: Terminal polish
- `a8ed6a3` feat: Terminal-first workspace
- `18741a2` feat: Live review file-change push via WS — repos + worktrees
- `90bd325` feat: Mobile terminal surface — xterm.js on mobile + Terminal/Chat lane
- `128957d` feat: Terminal infrastructure
- `71ad144` feat: Launch modal UI
- `e24244b` feat: Universal launch pipeline
- `f6c89fd` feat: Repo registry polish
- `6a67da7` feat: Analytics page — cost dashboard with real data
- `7a17612` feat: Agents section collapsible — same pattern as Activity
- `9df7f9b` feat: Activity as collapsible dropdown above agent cards
- `5f3eef1` feat: Issue assignment panel + ThoughtsCard z-index fix
- `6c049e4` feat: Active session pulse on timeline drill-down cards
- `1a6d421` feat: Session cost tracking — real token usage + spend per session
- `b101847` feat: Connected session panel with live SVG bezier connector
- `9bc30ce` feat: Timeline drill-down — double-click for per-agent breakdown
- `5c43c1d` feat: Clickable PR diff on agent cards — opens PR viewer in Canvas
- `63963ed` feat: WS-driven AgentPanel + TitleBar status dot + full dedup (-6)
- `670bee1` perf: Wire WS for diff stats + remove redundant polls

## 2026-03-16

- `f2f84d6` feat: Wire WebSocket to desktop chat — real-time streaming
- `c81120e` feat: agent runtime agents show their active repo's diff
- `43e2b39` feat: Live Diffs for all 3 runtimes + UX fixes
- `e648662` feat: Live Diffs — beautiful real-time code change viewer
- `5d3075c` feat: Live Agent Output panel + agent card pulse
- `94c2615` feat: Real diff stats on main + real timeline activity bars
- `0fbccc8` feat: Real context % for agent runtime sessions + diff stats
- `0622226` feat: Wire real workspace data — PR status + diff stats on agent cards
- `5454961` feat: agent runtime sidebar chat
- `ce6ea21` feat: agent runtime transcript — read session JSONL into sidebar
- `3fbfd2c` feat: Smart naming on collapsed card dots too
- `893de1a` feat: Better naming in agent cards
- `7e177ec` feat: agent runtime sidebar chat — send messages via CLI print mode
- `fef1a67` feat: agent runtime synthetic sessions for unmatched live processes
- `8a67d35` feat: agent runtime sessions appear in fleet with live PID detection
- `b579ca7` feat: Status-grouped agent cards + Apple design polish
- `662ead4` feat: Full-size agent cards with everything visible
- `d6b4ac3` feat: Show heartbeat intervals on agent cards (read-only)
- `6634243` feat: Agents tab in Settings — fleet dashboard with model editing
- `5572534` feat: Merge WorkspacesPanel into AgentPanel — unified view
- `f857ea1` feat: WorkspacesPanel — status-grouped workspace cards
- `ae1aeef` feat: Cmd+K keyboard shortcut to toggle Thoughts Card
- `231ecf0` feat: Context-aware suggestions in Thoughts Card
- `508b34b` feat: Agent picker in Task chat — route to any agent
- `4d921c1` feat: Approval routing in Thoughts Card + test simulation
- `c5baa97` feat: Task mode — mini chat inside Thoughts Card
- `2cef4fc` feat: Thoughts Card — Issue vs Task modes + resize fix
- `ff5e6d1` feat: Thoughts Card — resize handles + agent connection
- `818e1a6` feat: Thoughts Card — floating glass command surface
- `00802a9` feat: Settings page with GitHub connection status
- `7b5a14a` feat: Intent Canvas V0 — Fleet Command Center in workspace
- `6da96c2` feat: SessionTimeline Phase 1 — hover scrubber + real data API
- `01ace93` feat: Timeline Expanded View — full session replay in Canvas
- `bf8c66e` feat: SessionTimeline V0 — agent activity replay bar
- `b9e4f6d` feat: TitleBar window controls — sidebar/back/fwd/bottom/chat/settings
- `0146ded` feat: TitleBar search is now live UniversalSearch + red settings gear
- `0c0e631` feat: TitleBar
- `f5263e8` feat: Desktop NavRail
- `16a2b8c` feat: Session Info Sheet
- `e54a7db` feat: Universal search
- `df7367b` feat: Proactive alert system — engine, context, bell, tray, toast
- `4419a11` feat: REST API resilience

## 2026-03-15

- `b63f3ef` perf: gateway REST API client — 23ms vs 38s CLI cold-start
- `18c90fc` feat: Heat map top-down view + fix fly-in stale closure
- `377f27c` feat: Search dropdown with grouped clickable results
- `e4d52e5` feat: Knowledge Graph v3 — double-click fly-in + search fact nodes
- `418ef8f` feat: Knowledge Graph v2.3 — zoom-aware labels + ambient fireflies
- `ffc54c5` feat: Knowledge Graph v2.2 — depth fog + all labels + text polish
- `b6b6dbc` feat: Knowledge Graph v2.1 — bar gradients + floor reflections
- `8be40cd` feat: Knowledge Graph v2
- `059b44f` feat: Auto-refresh Knowledge Graph stats every 60s
- `2d45dca` feat: Replace lava lamp with Interactive 3D Knowledge Graph Explorer
- `48c367e` feat: Memory lava lamp v2
- `3f48793` feat: memory Lava Lamp — living particle visualization
- `3fbbf87` feat: Image rendering in mobile chat + click-to-expand lightbox
- `4b0d8e0` feat: Image rendering in chat + click-to-expand lightbox
- `638a8a7` feat: Typing indicator — animated dots while agent is thinking
- `f47ed9f` feat: Deployment Status (Vercel) + Git Log + Image Preview complete
- `2dc08c3` feat: Git Log viewer + Image/Asset preview
- `ef3c82b` feat: Issue Creator with AI enhancement (AI provider)
- `67a5f5b` feat: Global workspace search + PR review comments with diff context
- `72e05c7` feat: CI tab in agent panel
- `7ef90f9` feat: Changed file highlighting, clickable files, CI button
- `a188763` feat: README viewer, CI/GitHub Actions, file diff preview
- `8dc375a` feat: Stop button + project-scoped data + no auto-transcript popup
- `b3e9d0e` feat: Project-scoped Issues, PRs, and Files — data follows workspace
- `5d9591d` feat: PR Review tab + canvas viewer — full GitHub PR detail inline
- `3af091a` feat: Commit detail viewer — click any commit in Activity tab
- `0b30593` feat: Agent panel groups by workspace — matches chat session picker
- `19b82c0` feat: Show all agents including agent runtime/agent runtime in agent panel
- `352b261` feat: Issue detail full-width + diff opens in canvas tab
- `ac13ffe` feat: Drag-and-drop + paste + click-to-attach files in desktop chat
- `86d5fba` feat: Vertical drag handle for canvas — resize workspace/canvas split
- `508f852` feat: Contextual Canvas — bottom-half tabbed workspace
- `b4b2d9a` feat: Click agent surface → switches chat to that session
- `c1135d5` feat: Agent cards v2
- `653a182` feat: Proper markdown rendering in issue modal
- `ab157be` feat: Light theme + clickable issues with glass modal
- `e65be2d` feat: Three-column layout — Agent Panel | Workspace | Chat
- `6ab4621` feat: Agent Command Center
- `e71d2ed` feat: Glass diff modal
- `e4690cb` feat: Draggable compose bar — resize input height by dragging up
- `2c697aa` feat: Glass modal for Mermaid diagrams — expand, zoom, pan
- `beedb8a` feat: Mermaid diagrams on mobile — same o8 frost theme
- `8c1f6b5` feat: Styled CodeBlock + Mermaid diagram viewer
- `276067e` feat: Transport controls — message actions morph during playback
- `0c91779` feat: Point-to-Play
- `f0c24f6` feat: TTS Engine + Message Action Bar — Play/Copy/Retry on every message
- `1338f05` feat: Desktop chat header — exact mobile TopBar clone
- `575541b` feat: Desktop chat sidebar — mobile-identical chat on Dashboard v1
- `9560da7` feat: Dashboard v1
- `2b53d21` feat: wire o8 v1.2.5 fixes — fact_ids, stale flags, real graph
- `a6bfb25` feat: grouped squad picker with expand/collapse
- `4b7698b` feat: native shell v2 desktop shell
- `9af1036` feat: squad picker dropdown on TopBar title tap
- `e31ca63` feat: wire memory surfaces into shell
- `6f2b969` feat: memory Integration — all 8 issues (-)

## 2026-03-14

- `fff8838` feat: Phase 2
- `f41508c` feat: worktree isolation Phase 1
- `c773f3d` feat: universal runtime adapter contract + agent runtime integration
- `58091a6` feat: code block rendering — fenced code + tool output cards
- `ae4290f` feat: native markdown table rendering — beautiful HTML tables in chat view
- `af6455b` feat: unified WebSocket — real-time push replaces SSE + polling
- `6078ff6` feat: PWA
- `ae4baf2` feat: virtual scrolling for transcript — DOM bloat eliminated
- `0143de0` feat: consolidated sync API — 5 requests → 1
- `95b06c7` feat: prompt enhancement
- `cffa471` feat: approval primitive
- `a28dbb3` feat: cost dashboard
- `9360ccb` feat: wire json-render Renderer into mobile shell
- `ac850ea` feat: json-render integration
- `04965e5` feat: agent runtime chat parity
- `4a282df` feat: seamless agent runtime chat
- `2cfbf88` feat: auto-switch to launched agent runtime session
- `9d8aa6b` feat: clean agent runtime chat view
- `ea09b71` feat: discovered agent runtime session transcript
- `07f0dcd` feat: live process fallback
- `286f339` feat: mobile agent runtime launch

## 2026-03-13

- `ce3a5ef` feat: unified chat for agent runtime sessions
- `6d9cf06` feat: show all agent runtime sessions in squad (no stale filter), dedupe by branch, show branch in pills
- `59dd747` feat: project-grouped squad rail
- `e3abcb8` feat: native streaming
- `2766c24` feat: commit summary card in diff view (zero AI
- `3a295ce` feat: observable agents
- `53bde19` feat: squad cards
- `5efa10b` perf: diff view
- `d6e646b` perf: review-file 10s cache + only poll when diff open, tighter idle behavior
- `f27d88b` perf: request dedup, 8s inbox cache, 5s transcript cache, round usedPercent, suppress hydration
- `d6f0f4a` perf: adaptive polling (20s idle, pause on hidden tab, resume on focus), CSS containment, layout isolation
- `f9c82c3` perf: diff-and-patch transcript + snapshot — eliminate flash on idle polls
- `4384eb8` perf: skeleton loading, lazy images, send click, API caching (3s transcript, 5s inbox)
- `8731f59` perf: smooth scroll, message fade-in, optimistic user messages, image caching, typing bubble animation
- `9887ba6` design: red send button + red typing dots — matches hamburger accent
- `c9cf14f` design: solid red menu button, context pressure in bottom bar, doc tab apple redesign
- `1e30be5` design: full mobile UX pass
- `2715fee` design: apple-grade controls sheet + sticky diff files survive compaction
- `b4ae629` design: apple-grade diff polish

## 2026-03-12

- `00c14db` feat: surface queued agent runtime turns and clearer mobile send actions
- `f7f54ff` feat: add quick thread switching for mobile agent runtime lane
- `b632459` feat: make owned agent runtime mobile lane feel conversational
- `7bf408e` feat: allow owned agent runtime interrupt on mobile
- `e480039` feat: preload owned mobile diff context on focus
- `c740a25` feat: extend owned agent runtime review and resume on mobile
- `b42b018` feat: make owned review packets actionable
- `4a316a5` feat: add owned agent runtime review packets
- `6de7309` feat: surface owned agent runtime watch lane on mobile
- `e1a47bb` feat: harden owned agent runtime lifecycle and tail views
- `dc22116` feat: add owned agent runtime launch and resume lane
- `6b7ffee` feat: add runtime action ownership seam
- `fdc24f5` feat: promote runtime inventory and agent runtime activity detection
- `7217d07` feat: surface local agent runtime runtime discovery in desktop shell
- `b1650ee` feat: harden mobile operator chrome and review cockpit
- `6a3cdd2` feat: add panel and terminal shells to mobile queue
- `ffd2e4a` feat: add mobile per-file review drilldown
- `add6a8e` feat: deepen mobile review lane and glass styling
- `8ca65c3` feat: align desktop repo truth with live review state
- `2e94bb3` feat: wire direct mobile actions and history

## 2026-03-11

- `bbe5dab` feat: add mobile control inbox foundation
- `e63edc8` feat: wire live agent runtime bridge and workflow review
- `868b012` feat: add native desktop shell wrapper and guardrail surfaces
- `8a8b077` feat: bootstrap command center shell and runtime contracts
