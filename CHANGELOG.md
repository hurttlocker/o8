# Changelog

Development activity for o8 — the governance layer for autonomous engineering teams.

We ship high-signal entries only (features + performance wins). Bug fixes, refactors,
and internal chores live in the private engineering log.

---

## 2026-05-06

- `4de26a1a` feat: project colors + drag-drop repos onto dots + empty-project hint
- `56fc03ad` feat: rename / delete projects + move repos between them
- `d82af473` feat: status bar centers under the workspace + cluster matches chrome chip shape
- `1ec86716` feat: status bar centers branch + adds contextual merge action pill
- `8952101e` feat: O8 right panel opens on the Pulse tab by default
- `26e98fb2` feat: projects scope the left panel with a bottom-bar dot switcher
- `d4c07597` feat: hover × on each spawned agent row to dismiss it from the panel
- `3666075d` feat: single-runtime chat lifecycle + 3-word tab labels everywhere
- `dcd8c7d8` feat: breadcrumb minimizes to filename only by default
- `4d1b05b4` feat: Changes count gains a cool-to-warm urgency badge
- `67960804` feat: move repo selector into the changes rail to free file path space
- `5c564bf0` feat: chat tabs adopt 3-word summary from latest user message
- `01613ebb` feat: tab strip uses theme-tinted glass instead of raw vibrancy
- `71187351` feat: round workspace top corners and inset tab cluster
- `38a9edc2` feat: tab strip becomes vibrancy-passthrough glass
- `ef5357fb` feat: hide thinking chooser in chat tabs and rename Assistant row to Chat
- `56744b34` feat: chat-mode chooser spawns dedicated tabs with tool-wired chat
- `fa396dbe` feat: align orchestrator empty state
- `1aee38c5` feat: refine o8 settings and analytics ui
- `62100102` feat: refine o8 activity review surfaces

## 2026-05-05

- `7c43f059` feat: redesign o8 pulse briefing
- `478ec8bf` feat: refine o8 workspace panel

## 2026-05-03

- `6d63cfe2` feat(workspace-tab): green tab marker when packet status === released
- `3a6c58c5` feat(workspace-chat): inline status banner at bottom of dispatched chat
- `5fbce8ae` feat(o8-panel): consolidate Mission rail into Activity tab
- `0b48b875` feat(o8-panel): packets render in Activity timeline behind opt-in flag
- `56c30780` feat(orchestrator): NEEDS YOU click pops O8 Workspace pinned to the lane's worktree
- `58554aa3` feat(orchestrator): per-section click routing for Recent Work rows
- `5fbd890e` feat(orchestrator): status-anchored Recent Work — Needs you / In flight / Done today
- `c4dfad89` feat(o8-panel): path-lens chip on Workspace tab — shows main vs worktree at a glance
- `7b1eac39` feat: replace o8 file tabs with workspace
- `0ff128a5` feat: add o8 workspace pane components

## 2026-05-02

- `b7e0affe` feat(o8-panel): restore Pulse tab — live fleet temperature surface
- `8319ee71` feat(orchestrator): composer footer threads/copy/new + thinking <details> popover
- `3a44bba7` feat: stream orchestrator chat from gateway
- `5e28f087` feat: add clerk gated chat route
- `54771cb9` feat: add chat gateway server helpers
- `daa4cef7` feat: route orchestrator chat mode locally
- `22273536` feat: add chat mode card
- `d937e6c1` feat: add orchestrator chat model picker
- `7a4b4fb8` feat(mcp): wait_for_mission_ready
- `c83eebfa` feat(orchestrator): wire useFileDrop into ComposerArea

## 2026-05-01

- `6cae523e` feat: auto-release merged review packets
- `b2b90f3c` feat: tighten supervisor inbox signal
- `4dace31a` feat(browser-button): hover preview iframe of the active browser tab
- `f50020d3` feat(titlebar): promote Browser to top header slot
- `58c842fb` feat(left-panel): collapse branch + agent rows into one work-unit line
- `c794c1e5` feat(left-panel): repo focus expands the column inline, no overlay
- `30ff04aa` feat(chrome): move update notice to footer pill, drop top-right toast
- `ff3f0c12` feat(repo-focus): back-arrow polish + ESC-to-close
- `9d5ebc1d` feat: add o8 diff and spec tabs
- `3ff8e1f6` feat: add ambient right panel
- `e1402ef0` feat(repo-focus): Spec + Files tabs + first-class CLI usage strip
- `717f5567` feat(ui): repo-focused left-panel mode with Agents/Context/Mission tabs
- `f28c2029` feat(native shell): O8_DEV_FRONTEND_URL override for hot-reload prod loop [via-o8]
- `22bddea0` feat(native shell): O8_DEV_FRONTEND_URL override for hot-reload prod loop [via-o8]
- `2885036a` feat(native shell): O8_DEV_FRONTEND_URL override for hot-reload prod loop [via-o8]
- `a41bc632` feat: support dev frontend override in native shell

## 2026-04-30

- `81e51e7b` feat(ui): hide agent runtime pickers behind experimentalagent runtime + thicker tabs
- `1166d5d4` feat(operator): default thinkingEffort to high (was adaptive)
- `de689665` feat(runtime): drop agent runtime from default dispatch picker
- `d76702b3` feat(brain): fs.watch on docs — incremental re-distill
- `b8212560` feat(brain): embeddings column + hybrid retrieval
- `3f18657c` feat(brain): qa-eval regression dashboard
- `28aade08` feat(brain): post-commit hook feeds facts substrate
- `0d3d7d00` feat(ui): /ask quick action in chat composer
- `e3f12505` feat(brain): in-process compactor scheduler
- `5d15d1b4` feat(brain): bring-your-own OpenRouter / AI provider key surface
- `1a8432b9` feat(ui): Recall Card — top-N facts ambient surface
- `3cf3d4fb` feat(qa): configurable Class A composer model
- `19f4451d` feat(qa): Phase 2b
- `f92d7ed2` feat(qa): source-update detection + source-of-truth hierarchy
- `c38e4d93` feat(qa): fact compactor
- `a31eb634` feat(qa): Phase 2a
- `cd883202` feat(indexer): heuristic noise pre-filter at enqueue ( north star follow-up)
- `e1005e18` feat(indexer): parallel worker with O8_INDEXER_CONCURRENCY ( north star follow-up)
- `5fb0e0df` feat(qa): Engineering Brain Indexer worker
- `33fde327` feat(qa): pin top-6 facts above other retrieval rows ( north star)
- `c742f23a` feat(qa): smoke:qa fast eval (6 cases, <2min) replaces 30-case heavy eval ( north star)
- `7baed364` feat(qa): facts schema v17 + retriever foundation ( north star)
- `69631b3a` feat(qa): docs_fts ingestion for project rules / README / AGENTS.md ( path-to-70 phase 1.7-)
- `bcd0cf22` feat(qa): github_comments_fts ingestion ( path-to-70 phase 1.7-)
- `63aa9d81` feat(qa): rebench OpenRouter primary with credited key ( path-to-70 phase 1.7.1)
- `e18f0aa6` feat(qa): lock OpenRouter primary to grok-4.1-fast from empirical bake-off
- `ae9bd305` feat(qa): project + project_repo retrieval in sqlRetriever ( path-to-70 phase 1.4)

## 2026-04-29

- `0f3483df` feat(qa): 30-question eval set + runner skeleton (epic sub-3 wave A)
- `7b60b3a4` feat(qa): Schema v14 + FTS5 + retrievers (epic sub-1)
- `c3107842` feat(qa): Ask Anything UI scaffold + mock stream (epic sub-4)
- `f529dff4` feat(projects): AI Stage 2 LLM project suggestions + Confident/Plausible UI (epic wave 2)
- `f5b3b608` feat(projects): Settings → Projects UI with manual linking + GitHub-org auto-suggest (epic wave 2)
- `628495ba` feat(projects): Recall Card Project pulse section (epic wave 2)
- `ebbfd6da` feat(projects): scope:project directives + cross-repo proposer rewrite (epic wave 1)
- `ec4e3ce5` feat(projects): schema v13 + storage + API + MCP tools (epic wave 1)
- `2fcade70` feat(projects): AI semantics Stage 1 fingerprint extractor (epic wave 1)
- `2576b08f` feat: agent-proposed spec approval flow
- `dc0508a4` feat(diagnostics): extend demo runner with mission/settings/context-graph steps (closes)
- `099b6a46` feat(diagnostics): in-app demo-sequence runner (closes)
- `9d0fd5e6` feat(panel): loop-state writer endpoint + shell helper (closes)
- `29b370cc` feat(settings): in-app loop status widget — cron + lanes + recent merges (closes)
- `24fb98f9` feat(mcp): o8_view_console_errors + o8_view_active_route — close loop observability gaps (closes)
- `40124d3c` feat(o8): cross-repo learning
- `e74dfa91` feat(o8): per-runtime outcome telemetry → dispatch routing recommendation (closes)
- `7409a9be` feat(o8): auto-directive proposer
- `44ef75b1` feat(o8): temporal validity windows on session_outcomes — auto-decay 30d (closes)
- `ead15d33` feat(mobile): Browser tab gates the chat+iframe split (closes)
- `8edf1dc2` feat(mobile): wire url-push listener into split shell + DevHostFrame handler
- `1d489b16` feat(mobile): long-press port chip pushes URL to connected phone over WS (closes)
- `b01eb931` feat(mobile): wire DevHostFrame into MobileSplitShell right pane
- `dcc44eae` feat(mobile): landscape split-view shell
- `7df82d56` feat(mobile): DevHostFrame iframe with URL bar + LAN host discovery (closes)
- `a8415187` feat(context-engine): editable packet spec.md feeds live orchestrator context (closes)
- `e1b47aa8` feat(mission-control): status-grouped lanes (closes)
- `371c020e` feat(orchestrator): suggested-reply chips under Coordinator messages
- `9dceb63c` feat(o8): living specs
- `1ead5f84` feat(context-engine): /context-graph test page — 3-column flow viz (closes)
- `5674f2d2` feat(native shell): dispatch popover redesign

## 2026-04-28

- `61138692` feat(o8): demo polish
- `9a0492ac` feat(o8): inject <context> block into packet bodies on dispatch (closes)
- `f3b26e4e` feat(orchestrator): context recall card 3-row hero (closes)
- `42bbf86d` feat(o8): auto-index registered repos at boot via codebase-memory-mcp (closes)
- `d4f25cb3` feat(mcp): register codebase-memory-mcp in .mcp.json + setup generator (closes)
- `4ae59a8c` feat(mcp): runtime-download codebase-memory-mcp on first launch (closes)
- `b65834f6` feat(native shell): global-shortcut + notification + menu bar tray (closes)
- `30b1e411` feat(orchestrator): packet review card 3-pane (closes)
- `d52ff056` perf(dashboard): defer non-critical work off the bootstrap path (closes)
- `afa0aff1` feat(workspaces): hover-reveal trash + confirm-strip + git branch -D
- `e255f348` feat(desktop): auto-hide merged + agent worktrees in Workspaces sidebar + hover-prune
- `60c892da` perf(desktop): memoize ThoughtsChatPanel message bubbles
- `cb9e73b9` perf(desktop): widen / remove short polling intervals
- `ac058e40` perf(desktop): reduce SessionVisualizer render churn
- `bb3bcc1f` feat(desktop): hit-zone audit — Settings page (44pt minimum)
- `4662f5c4` feat(desktop): hit-zone audit
- `f0da0757` feat(desktop): hit-zone audit — Approval surfaces (44pt minimum)
- `5c22d514` feat(desktop): multi-window / split-pane orchestrator transcripts
- `592029bb` feat(orchestrator): bump AI provider defaultModel to AI provider-3.1-pro
- `2c6fb4b7` feat(desktop): Cmd+K command palette across the app
- `32dbcd77` feat(desktop): one-click rerun-with-feedback on rejected reviews
- `e8b447ce` feat(desktop): inline diff viewer in workspace center
- `9af81251` feat(desktop): steer-in-flight composer on active agent transcripts
- `0bc22ad0` feat(orchestrator): drop AI provider-code from dispatch picker
- `067183e3` feat(mobile): offline send queue + replay on reconnect
- `df18c17c` feat(mobile): push notifications + Web Push infra
- `d825fcad` feat(mobile): haptic feedback
- `8c0b38f3` feat(mobile): pull-to-refresh across mobile surfaces
- `e25d03a4` feat(mobile): universal search ('/') across chats/threads/activity
- `3fa902ec` feat(mobile): markdown + code blocks in agent transcripts
- `e1caad40` feat(mobile): swipe-to-approve/reject gestures on approvals
- `b6a04b17` feat(mobile): inline diff viewer for approvals + PR cards + agent transcripts
- `fa09d3ae` feat(mobile): inline diff viewer for approvals + PR cards + agent transcripts
- `29882140` feat(mobile): inline diff viewer for approvals + PR cards + agent transcripts
- `97fc6936` feat(mobile): inline diff viewer for approvals + PR cards + agent transcripts [via-o8]
- `78412db7` design(mobile): dark mode transcript bubble polish [via-o8]
- `5ec52cf6` feat(mobile): voice input via long-press to dictate [via-o8]
- `da4f2232` feat(mobile): voice input via long-press to dictate

## 2026-04-27

- `cdac1e25` feat(mobile): read-only agent transcript sheet (v1 mobile model)
- `fc6c9899` feat(mobile): orchestrator brain chip + thread card opacity fix
- `57f05cee` feat(mobile): rename Chats→Assistant, action-weight order, sidebar subtitles, orchestrator New button
- `1c0e5a1d` feat(release): post-bundle sign + notarize for nested Node native modules
- `efc3bbfe` feat(release): wire Apple Developer ID signing + notarization
- `edf81be4` design(orchestrator): match Assistant chat breathing room and typography
- `ecb1fa2f` design(mobile): unify standard topbar across all 5 new tabs
- `83daf55c` design(mobile): scroll-fade masks on chat list/transcript/orchestrator/approvals scroll surfaces
- `a625c992` feat(mobile): profile button + Settings sheet under drawer footer
- `6a7058ef` feat(mobile): wire 5 unwired tabs (agents/issues/activity/costs/orchestrator)
- `d521569e` design(mobile): filter pills, day groupings, FAB, HIG touch-target sweep

## 2026-04-25

- `c8547569` feat(mobile): orchestrator tool bubble flips to done with output preview
- `f9684e54` feat(mobile): bind bundled Next server to 0.0.0.0 for LAN access
- `6f5388b8` feat(mobile): orchestrator composer wiring polish
- `17518b30` feat(mobile): orchestrator tab — thread strip + transcript + composer
- `49482d9f` feat(settings): factory reset button in Diagnostics tab
- `25c74382` feat(mobile): orchestrator WS hook with transcript buffer
- `6dedea6b` feat(mobile): orchestrator threads list API + types

## 2026-04-23

- `84460bc5` feat(onboarding): add default dispatch runtime step to first-run wizard
- `e3374aa8` feat(v1): gate agent runtime behind experimentalagent runtime flag

## 2026-04-21

- `8830d978` feat(AI provider): model fallback cascade on quota + in-chat pill
- `05d5039c` feat(agent-panel): Orchestrator + Assistant rows with accurate shimmer
- `77184bde` feat(hotkeys): Cmd+1-9 jump, Cmd+Opt+Arrow cycle, Cmd+W close + tab flash
- `8c57d71f` perf: kill AgentTilePane polling + fleet invalidate route + urgent WS (Packet D,)
- `fa6a8ef7` perf: rewire WorkspaceChatPane to transcript store (Packet B,)
- `3e2e844c` design(AI provider-code-transcript): emit structured toolCalls for agent runtime-parity italic dropdowns
- `1c82ea51` perf: visibility swap + render memo on tab panes ( Packet C)
- `f3eb16b3` perf: client transcript store + workspace bootstrap ( Packet A)
- `a9790994` design(chat): collapsible PacketHeaderCard replaces giant packet prompt
- `da098e4c` design(branch-hover): Rams-style status rows matching repo hover
- `6aee18d6` design(branch-hover): match repo-hover theme — solid panel, no glass
- `e53c8be7` feat(workspace): wire AI provider + agent runtime chat-pane transcript + steering
- `40f2c5eb` design: hide SessionTimeline + punchier shimmer + strip branch tooltip
- `102e3e8e` design: o8 boot splash + shimmer on active agent panel label

## 2026-04-20

- `3e66b94f` feat(workspace): wire AI provider + agent runtime into CLI Session live-tail pane
- `073aa41a` feat(orchestrator): expand OrchestratorRuntime union to four runtimes + capability map
- `dc61c806` feat(runtimes): add first-class AI provider CLI adapter
- `f835da1c` feat(runtimes): add first-class agent runtime CLI adapter
- `23c8ca11` design(chrome): shimmer sweep on active workspace tab label
- `be784c13` feat(runtimes): add turn-dispatcher primitive (no callers yet)

## 2026-04-19

- `559a9c98` design(theme): unify midnight chrome glass + solid page surface on Settings/Analytics + inbox pill
- `b4785637` design(settings): RamsButton pill sweep + CornerBrackets selection + SectionLabel brightness
- `66eaa4b9` design(chrome): Rams palette, remove alerts tray, quiet timeline strip, tighten Session Replay
- `ef1268ba` feat(ui): reload banner in ThoughtsChatPanel [via-o8]
- `4d04dacc` feat(orchestrator): graceful reload endpoint with transcript resume [via-o8]
- `e861f1e5` feat(mcp-register): add o8.register_mcp tool for conversational MCP install [via-o8]
- `6a0b58b5` feat(mcp): adaptive probe timeout + npx prewarm [via-o8]
- `3f7a3734` feat(mcp): test connection button with live tools probe [via-o8]
- `82295a64` feat(mcp): paste-JSON config input [via-o8]
- `6c4606a3` design(settings): acronym casing — MCP + configuration [via-o8]
- `8cef91d6` design(settings): visual polish sweep — spacing, acronyms, typography [via-o8]
- `c3a722a1` design(analytics): Rams pass
- `5e91e677` design(settings): Rams pass on Settings shell + tab bar [via-o8]
- `83931920` design(settings): Rams pass on About tab [via-o8]
- `3209c5fa` design(settings): Rams pass on Diagnostics tab [via-o8]
- `7407acfa` design(settings): Rams pass on Appearance tab [via-o8]
- `ab05c4c3` design(settings): Rams pass on Cloud Workers tab [via-o8]
- `86984414` design(settings): Rams pass on Workers tab [via-o8]
- `facc19cb` design(settings): Rams pass on Dispatch tab [via-o8]
- `4e70379e` design(settings): Rams pass on MCP tab [via-o8]
- `910321dc` design(settings): Rams pass on configuration tab [via-o8]
- `b305eb09` design(settings): Rams pass on Connectors tab [via-o8]
- `2c6e1be2` design(settings): add TabBreadcrumb + TabHeading + FieldLabel Rams primitives [via-o8]
- `2565109c` feat(agent-hover): diff + last-tool + elapsed on hover [via-o8]
- `b852c1e7` feat(security): promote configuration encryption to macOS Keychain-backed master key
- `78f69c26` feat(delegate): accept baseBranch param for fix dispatches against feature branches [via-o8]
- `bfeb1ea6` feat(orchestrator): edge-case surfacer at dispatch-prep time [via-o8]
- `cb588908` feat(governance): autonomous post-merge decomposition pipeline [via-o8]
- `8e6f8a14` feat(chat): streaming DiffCard with partial-apply and interrupt [via-o8]
- `b37468c2` feat(runtime): cloud adapter scaffolding with outbound-only worker protocol [via-o8]
- `e82f2250` feat(orchestrator): render ComparisonCard + fan-out cost warning in mission panel [via-o8]
- `784bfee7` feat(orchestrator): guard PacketCard against comparison-group packets [via-o8]
- `58f9a244` feat(orchestrator): ComparisonCard mission-panel UI for best-of-n groups [via-o8]
- `60fc6e25` feat(orchestrator): comparison-meta API route for best-of-n meta-agent [via-o8]
- `59e578be` feat(orchestrator): add global AgentsSidebar for all-origin agent visibility
- `4e79747c` feat(orchestrator): external MCP servers as orchestrator context sources
- `0257de19` feat(agent runtime): eager-parse auth.json to expose authed providers as picker sub-rows
- `96c09660` feat(worktree): force managed mode for AI provider-code lanes so pre-launch rebase runs [via-o8]
- `6892fdb5` feat(orchestrator): wire packet issueUrl into PacketActionStrip open action [via-o8]
- `e401b1b3` feat(composer): wire stop pill to real interrupt channel [via-o8]
- `c1d8632e` feat(mcp-agent): o8_merge_preview tool + structured gate verdict on workflow action
- `d2ff2a4f` feat(orchestrator): packet card details popover [via-o8]
- `3ef5fe56` feat(mcp-agent): o8_packet_transcript MCP tool paginates packet agent runtime events [via-o8]
- `e39e9245` feat(orchestrator): Cmd+K quick-action palette in OrchestratorTab

## 2026-04-18

- `129d5775` feat(mcp-agent): o8_lane_events MCP tool long-polls workflow transition [via-o8]
- `9bd9bb2f` feat(mcp-agent): o8_review_state MCP tool
- `ae0128ca` feat(orchestrator): packet card action strip — retry / reset / open / copy [via-o8]
- `7e2e43b5` feat(orchestrator): history row actions — pin / rename / export / delete [via-o8]
- `f62fefb5` feat(orchestrator): synchronous worktree cleanup across all merge paths [via-o8]
- `201a9e71` feat(orchestrator): history sidebar search with first-message match [via-o8]
- `30477f11` feat(composer): Rams-style send pill with idle / armed / working states [via-o8]
- `132f8aab` feat(orchestrator): packet file-reference validator + emoji fix
- `6f5b3372` feat(dispatch): learned-rules promotion/demotion cron
- `43a64b0c` feat(orchestrator): inject learned rules into packet prompt
- `ea5aabed` feat(orchestrator): preserve pinned turns during auto-compact
- `a90a4b27` feat: archive orchestrator threads on clear
- `4b3f07a3` feat(orchestrator): finish remaining slash commands
- `bd4e7cb1` feat: usage.jsonl dispatch instrumentation for agent runtime + agent runtime runtimes [via-o8]
- `306b48f5` feat: wire Thoughts operator-defaults into panel [via-o8]
- `7705f45d` feat: default operator settings
- `a76283e0` design(agent-chat): unify agent runtime + agent runtime composer with orchestrator aesthetic
- `019c78f1` feat(orchestrator): context inspector side panel with click-to-evict
- `4febf47f` feat(worktree): stale local ref check + fetch_unreachable supervisor inbox kind so offline launches don't revert upstream [via-o8]
- `e9f30de5` feat(worktree): thread packetId through RuntimeLaunchRequest so rebase-conflict inbox rows deep-link to the packet [via-o8]
- `724c81bd` design(orchestrator): ThinkingChip matches ContextMeter pill aesthetic
- `b8dad79c` design(governance): move Supervisor Inbox from lingering /dashboard/inbox route into the O8 right panel as a proper tab
- `cc0f14e0` feat(agent runtime-debug): attach native review screenshots
- `08ab4c68` feat: add orchestrator composer token estimate
- `816c29e7` design: ThinkingChip uses theme tokens, drops Material shadow + backdrop-blur
- `5e5d78cd` feat: add orchestrator thinking footer chip
- `a6eb6640` feat(orchestrator): refine slash command controls
- `91cf88a2` feat: add supervisor escalation inbox
- `24eb3839` feat(governance): add heal-bot inbox worker
- `3922c796` design: slim orchestrator file mutation rows
- `a5d07539` feat: add adaptive orchestrator thinking summaries
- `b7753c32` feat(orchestrator): rotate thread after mission completion
- `eea81143` design(orchestrator): drop SESSIONS strip, compact packet tab labels, highlight latest dispatch
- `4b461625` design(orchestrator): CommandStripNode density pass

## 2026-04-17

- `f47b717d` feat(orchestrator): /clear /compact /focus /status /recall /handoff slash commands [via-o8]
- `7c95bd0c` feat: add orchestrator slash command controls
- `6b084ea7` feat(orchestrator): /clear command + fresh-thread-preserves-mission-state [via-o8]
- `179e14e7` feat: add orchestrator clear command
- `76316b21` feat(infra): wire prompt caching for AI provider 4.7 orchestrator [via-o8]
- `32220e18` feat: cache AI provider prompt prefixes in llm proxy
- `d4a92b29` design(agent-chat): share DesktopToolCallStack in MessageBubble [via-o8]
- `58d9674c` design(agent-chat): share DesktopToolCallStack in MessageBubble [via-o8]
- `4022f13c` feat: auto-compact orchestrator threads at 30 percent context
- `7a9cd813` design(orchestrator): move context down, copy up, shrink session cards [via-o8]
- `4566a63c` feat(orchestrator): token meter + ThreadsDropdown + header compression [via-o8]
- `b72264ac` design(orchestrator): unify expanded tool lines — read uses same format
- `6b51b6f4` design(orchestrator): invert batchable — only file writes/edits earn cards
- `d6c5d4ce` design(orchestrator): collapse tool calls into italic Rams-style line
- `6cb250b2` design(chrome): lift text + chrome-pill colors over vibrancy
- `956cbf68` design(approvals): ghost-orange buttons + clearer expand affordance
- `070132b0` design(approvals+orchestrator): tighten to Rams density
- `8fa84cbf` feat(approvals): first-class merge-gate banner under TitleBar
- `239c765f` feat(orchestrator): unified busy-state UI + stream event routing [via-o8]
- `a1d88504` feat(lane): tag merged lane tip commits with [via-o8] suffix
- `6f637586` feat(theme): shift light-mode glass family from white to paper base
- `be12215d` feat(theme): light-mode content surfaces use paper (#F4F2ED) — match o8-site

## 2026-04-16

- `e336cd03` feat(cloud): standalone worker CLI reference implementation
- `781f6870` feat(lane): route remote-customer merges through merge gate
- `1cf339c2` feat(settings): Workers tab UI + worker tokens API + feature-flag helper
- `dfd061f3` feat(dispatch): inject learned rules into packet prompt
- `57206196` feat(dispatch): learned-rules promotion/demotion cron
- `2d58081c` feat(cloud): CustomerWorkerTransport + register remote-customer adapter
- `7fdbd070` feat(cloud): worker poll + event endpoints with token auth
- `bd05bb2b` feat(db): worker_tokens + worker_runs + worker_events tables
- `f58ed2f5` feat(dispatch): dispatch_rules table + record from lane merge events
- `5517075d` feat(runtimes): scaffold remote runtime protocol types
- `f9bf7ef5` feat(sidebar): replace 'Idle' label with 3-word task summary
- `19b52557` feat(governance): autonomous decomposition pipeline

## 2026-04-15

- `7d08afa2` feat(supervisor): mechanical project rules rule enforcement at post-completion
- `ae92dcef` feat: add design mode overlay
- `c18aecf9` feat: branch picker wizard in packet dispatch
- `6f5fce13` feat(delegate): synthesize packet shell so governance tools find the lane
- `d6301dc8` feat: persist orchestrator plan text in chat history
- `c850fea3` feat: auto-capture lane review screenshots
- `5cacf223` feat: add external orchestrator mcp servers
- `4fd3a664` feat(orchestrator): Apple-style tool call cards + sticky working bar

## 2026-04-14

- `857df131` feat(orchestrator): export thread to markdown (closes)
- `1dba6aa9` feat(orchestrator): anti-patterns section + final-message format doctrine
- `10373985` feat(lane): reap idle abandoned lanes + safety guard main tree
- `c8d18e01` feat(history): archive tab in orchestrator history drawer
- `14badaf1` feat(workspace): merged read-only banner on retired chat tabs
- `1ae6852f` feat(lane): hide sidebar cards + packets bound to archived lanes
- `a9610331` feat(lane): auto-wrap manual runtime launches in a governance lane
- `6f83e71b` feat(mcp): add o8_view_wait_for for polling UI readiness
- `fcf31aa1` feat(lane): auto-archive stuck reviewing lanes + retire standalone native shell-mcp bridge
- `d772218c` feat(mcp): bundle o8_view_* webview tools + session picker + UI polish
- `2023d61d` feat: add timeline toggle to appearance settings
- `47867953` feat(theme): chrome-surface sweep + light blue accent + add-repo redesign

## 2026-04-13

- `4af65f91` feat(theme): chrome-surface scope for light mode glass buttons
- `9a5948d2` feat(theme): ship Light + Midnight only, light becomes glass chrome
- `3b1ee213` feat(mcp): ship native shell-plugin-mcp with the production build
- `31ea6297` feat(ship): local release script + ship npm scripts
- `fd1fe3c2` feat: Operator live fallback notice + Plan/Code permission chip
- `4d6394d6` feat: o8 Operator + drop legacy provider keys + agent runtime CLI runtime

## 2026-04-12

- `2f185245` feat: thinner fonts + desaturated diff in Changes panel
- `1f41c0f6` feat: unified user bubbles across all chats — subtle tinted pill
- `3d5cfe03` feat: thinner orchestrator chat text
- `9bbe71da` feat: roll Plus Jakarta Sans as the app-wide typeface
- `1d62ec13` feat: add Satoshi, Outfit, Manrope to typography specimen + match app sizes
- `58401eda` feat: add /text typography specimen page for font comparison
- `c392a174` feat: agent click scopes workspace panel to agent's worktree
- `a95d6d88` feat: aggregated Issues panel shows all repos grouped by sections
- `5e3d2c83` feat: repo alignment gesture — click repo name aligns whole app
- `38bc7c18` feat: multiple repos can be expanded simultaneously in sidebar
- `8adcc059` feat: fleet orchestrator UI — repo focus indicator + sidebar status
- `cc1eef1a` feat: orchestrator system prompt is fleet-aware across all repos
- `ee4054d4` feat: drag-to-reorder workspace tabs
- `ec5140ac` feat: session rows match orchestrator row layout
- `3eba2a8a` feat: rename CLI session tabs from 'Assistant' to 'Agent'
- `8d937cdb` feat: orchestrator tab is visually elevated and un-closeable
- `d5073897` feat: agent session tabs show repo + runtime instead of "Assistant"
- `f8c4889d` feat: apple squircle corners on right panel (O8 + workspace review)
- `0a98f238` feat: move permission + issues controls into composer toolbar

## 2026-04-11

- `c14077cb` feat: analytics apple pass + empty state respace + element picker iframe-proxy
- `e5948b7d` feat: midnight-aware terminal theme + navrail/titlebar consolidation
- `ef1ff62d` perf: gate headless sprint loop on queued packets
- `ec9d2328` perf: slim ws-server + lazy-spawn dashboard PTY
- `fefe98af` feat: orchestrator becomes a workspace tab with integrated history + mission

## 2026-04-10

- `df128de8` feat: mission dispatch echo + plan-mode banner in orchestrator tile
- `43c84672` feat: NavRail launchers for Mission Control + Orchestrator History
- `0ee546ef` feat: side-effect-class tool rendering + cross-tile orchestrator bus
- `89386ed9` feat: orchestrator/mission/history as tile-native components
- `98d7ef57` feat: thread permissionMode through sendToOrchestrator
- `31287253` feat: production hardening
- `aed9b509` feat: Node pre-flight + dynamic port allocation

## 2026-04-09

- `1d16f4ee` feat: AI provider Desktop auto-register + setupComplete schema fix
- `04e4c360` feat: MCP production hardening — auth, config distribution, bundling
- `e0e70743` feat: add shared token formatter
- `92ddffd7` feat: o8 v2 observability — Ledger + Preview tabs in Memory view

## 2026-04-08

- `c8c14ef9` feat: o8 v2 Phase 1 — directives store + session ledger + API
- `0bd6a4c4` feat: @-mention file suggestions on mobile chat compose
- `69be1685` feat: shared useFileDrop hook
- `6f94da5b` feat: enriched approval cards
- `79d7bc33` feat: pre-dispatch file overlap gate
- `48a878f7` feat: expandable detail rows in O8 Activity pane — click to expand inline context
- `ff56a196` feat: specialized mobile tool call cards — diff, shell, read, search

## 2026-04-07

- `f3ccb7a4` feat: mobile CLI chat backend
- `2a8f9a1a` feat: CLI chat backend
- `95f139ca` feat: o8 Assistant rebrand
- `0398f528` feat: add OpenRouter + xAI providers + key validation on save
- `a6b95fe8` feat: inline missions

## 2026-04-06

- `1425daa5` feat: commit viewer in O8 Changes tab — click commit to review inline
- `98f5fc5a` feat: click worktree to open agent transcript
- `c926c6f2` feat: collapse tool calls in transcript bubbles
- `18e0d587` feat: Activity tab in O8 Panel — unified activity feed
- `54797028` feat: compact activity badges on repo cards for ambient awareness
- `f5eebb22` feat: show conversation preview in chat tab labels instead of generic "Chat"
- `6e361fcc` feat: show agent runtime/AI provider brand logo in chat tab headers
- `15d20d74` feat: use official agent runtime + AI provider brand logos across all surfaces

## 2026-04-05

- `6bc9ebd9` feat: add runtime icons to session agent rows + collapsed branch badges
- `9b5c03ca` feat: replace CX/CC text badges with agent runtime and AI provider SVG logo icons
- `4e193f7a` perf: extract DashboardInner state into grouped context hooks
- `61c81451` perf: native shell IPC for SQLite endpoints
- `4ae7f87d` perf: virtualize transcript list for long agent sessions
- `a6282dd4` perf: lazy-load heavy Canvas tab components + o8TaskBoard
- `7a4da553` perf: deduplicate workspaces + inbox API calls on initial load
- `052980c2` perf: eliminate transcript render storm + 11 more polls → WS-driven + API dedup
- `5916e096` perf: native shell IPC commands for hot-path data reads — bypass HTTP stack
- `312262c9` perf: WS-driven invalidation for 18 polling loops + React.memo on 31 components (,)
- `babfed33` perf: replace 2 polling loops with useReactiveQuery
- `ce00a347` feat: TanStack Query + WS event bridge for reactive data layer
- `d9206f54` feat: MCP dispatch DX overhaul
- `b7ccc195` feat: truthful worktree status + cleanup stale worktrees
- `83743d32` feat: click worktree → open agent transcript in canvas ( v1)
- `1ad88484` feat: thinking indicator + faster polling for active agent sessions
- `2bd6c5ba` feat: port hover popover + open ports in O8 browser tab
- `23a33dbf` feat: open activity commits in O8 changes pane
- `376f426d` feat: instant PR cache invalidation after merge/approve/request changes
- `e8333127` feat: inline file diffs + merge conflict badge in O8 PR review
- `04a5a761` feat: PR count badge on repo card — click to open O8 PRs list
- `067dd2f1` feat: PR list view in O8 panel — all open PRs on one page
- `da722f7e` feat: PR review tab in O8 panel — replaces canvas PR viewer
- `0601aada` feat: collapsible root files section in O8 file tree
- `a7493851` feat: editable file viewer in O8 Files tab — competing product-style editing
- `08a5f973` feat: file browser in O8 panel Files tab — competing product-style split layout
- `88e94cd9` feat: dispatch pipeline hardening
- `779d9a4c` feat: wire Edit with AI + Open Source callbacks in O8 element panel
- `65d73b1f` feat: visual element selection panel for O8 Browser tab

## 2026-04-04

- `f454b6fa` feat: element picker bridge + source mapper API + rate limit fixes
- `5d6b8bd7` feat: O8 Browser tab — wire LocalhostPreviewTabs into O8 panel
- `d07fd20c` feat: O8 panel Changes tab — git status + inline diff + tab bar
- `e55df291` feat: O8 panel
- `cce11bbb` feat: mobile WS reconnect with exponential backoff + approval recovery
- `f656a6ed` feat: startup lane reconciliation
- `46a33161` feat: startup lane reconciliation
- `0b84a771` feat: GitHub intake pipeline — issue assignment to plan approval
- `65272faf` feat: persist runtime session costs to usage logs
- `b4022648` feat: o8 agent safety hooks
- `9dc48663` feat: mobile repo picker for multi-repo chat
- `f6777faa` feat: repo-scoped tool execution + repos API

## 2026-04-03

- `eaf7ae52` feat: apply file edits on approval approve
- `53c82c13` feat: add github tool for AI provider — gh CLI access
- `88140fad` feat: expand shell allowlist — npm, npx, node, cargo
- `8bcba207` feat: add create_file tool for AI provider
- `b673d369` feat: syntax-highlighted tool output — expand shows real code colors
- `421cab7e` feat: Apple-style collapsible tool call cards
- `bc512cb3` feat: AI provider tool execution backend
- `4f7fe6d4` feat: compact model selector + fix theme toggle in settings
- `e3c65623` feat: restore light mode with proper theme toggle
- `9e18da3a` feat: tool call card renderer components
- `9af39728` feat: tool call SSE protocol types and parser
- `e28fcf3b` feat: theme-aware markdown renderer + light mode code blocks
- `898d5551` feat: rebrand mobile shell for o8
- `dea51852` feat: rebuild mobile approvals and sidebar surfaces
- `8b4199fd` feat: rebuild mobile approvals and sidebar surfaces
- `fcd91ca5` feat: replace custom mobile chat with @assistant-ui/react Thread
- `9cce9754` feat: build mobile assistant-ui thread chat
- `d3f045f6` feat: mobile settings view + decompose monolithic client into focused modules
- `e89b6a65` feat: mobile redesign
- `289f3a09` feat: mobile settings view + decompose monolithic client into focused modules
- `0576fce9` feat: mobile settings view + decompose monolithic client into focused modules
- `af1a7152` feat: mobile settings view + decompose monolithic client into focused modules
- `3b7046b8` feat: mobile settings view + decompose monolithic client into focused modules
- `b44386f9` feat: mobile settings view + decompose monolithic client into focused modules
- `9ebbc383` feat: add mobile settings view to glass sidebar

## 2026-04-02

- `17f58ba7` feat: full glass input field + glass send button + scroll-to-bottom arrow
- `a4e0d289` feat: glassmorphic buttons
- `75aa5d29` feat: collapsible code blocks with diff coloring and file path labels
- `ec45fa7b` feat: TTS play button on assistant messages + AI provider-style input bar
- `c2327191` feat: starred + recents sections in sidebar, revert dots back to long-press
- `ca8ad50c` feat: long-press context menu on chat list — star, rename, delete
- `d63d2172` feat: AI provider-style chat list view
- `500dc19b` feat: AI provider-style message rendering + mobile markdown for code blocks
- `8763c403` feat: wire mobile chat to real chat history store + conversation list in sidebar
- `7a1aef00` feat: AI provider-style sliding sidebar + AI provider chat on mobile
- `3c40bb84` feat: add npm run tunnel for remote mobile access via Cloudflare
- `3b1c52ce` perf: prefetch mobile inbox on server
- `a6aed2a0` perf: break route barrel imports
- `ba662510` perf: switch dev to turbopack and lazy init db
- `14a417c0` feat: bound onAgentCompletion retry loop
- `7d82733a` feat: add attempt learning persistence
- `acb9bb3c` feat: add low-risk auto-approve policy
- `998b96e4` feat: add packet self-review confidence gate
- `56be609e` feat: objective exit criteria
- `471225d0` feat: compact Apple-style dropdown menu, no full-screen overlay
- `bc19c545` feat: AI provider-style tool cards in mobile chat
- `4228c8bb` feat: organize mobile sessions by type — Chats, Sessions, Missions
- `84f79425` feat: warm grey + light beige palette across all 30 mobile surfaces
- `5631e6c4` feat: slim compose bar
- `73ba8564` feat: in-process mutex on orchestrator-state.json
- `4b610bbf` feat: merge conflict escalation via approval card
- `16818234` feat: persist workflow watcher state to SQLite
- `dc3b6355` feat: orchestrator session health monitor — 90s timeout + auto-recovery
- `77a08e40` feat: persistent SQLite-backed review queue
- `32fa1ce8` feat: inline mission creation — no GitHub dependency
- `6481fce0` perf: mobile page is now client-only — zero server-side bootstrap
- `294efd58` perf: mobile optimization
- `79698cec` feat: copy AI provider mobile session list — clean rows, status groups, FAB
- `bf22b7de` feat: mobile new chat — launch LLM session from phone
- `7da466ac` feat: mobile wave 4
- `c7260974` feat: purge 4,277 lines of remodex CSS + remaining className from mobile

## 2026-04-01

- `d9e2df4d` feat: mobile waves 2+3
- `e5b78197` feat: mobile wave 1
- `276c93b8` perf: P1 bundle + network optimizations
- `a648a890` perf: P0 performance fixes
- `e161191d` feat: wire recommendMergeOrder() into merge pipeline
- `56443ba9` feat: merge gate file size block + operator override
- `a9961db6` feat: add FILE_SIZE_WAIVERS for layout orchestrators and multiplexers
- `e7dd4b3b` feat: skeleton map file size check at dispatch time
- `51227542` feat: InfinityGlow animated status indicator for agent cards
- `551e9952` feat: FTUX progressive feature reveal
- `43dd5381` feat: FTUX first-merge celebration state
- `366bd6fa` feat: FTUX mobile QR prompt
- `34f9348e` feat: FTUX First Mission Card contextual CTA
- `932ee1cb` feat: FTUX empty states for all dashboard panels
- `bd6c7c8a` feat: FTUX warm dashboard state
- `23b1bdb6` feat: FTUX personalized chat greeting
- `2bba0bfd` feat: workflow transition WebSocket channel
- `b79ae61f` feat: workflow transition WebSocket channel for real-time status streaming
- `0dd778db` feat: migrate approval store from JSON to SQLite
- `3b8deb9f` feat: migrate approval store from JSON to SQLite

## 2026-03-31

- `4f261749` feat: migrate lane registry from JSON to SQLite — kill cross-process clobber
- `fd0baca9` feat: sprint 6 wave 3
- `a18bc0af` perf: sprint 6 wave 2
- `e3321db6` feat: workflow watcher coordination
- `67d7083f` feat: route Audit Log to workspace tab instead of Inspector panel
- `0386c4b0` feat: sprint 5
- `72ddf139` feat: sprint 4
- `9fb9baa7` feat: sprint 3
- `26592858` feat: sprint 2
- `ff3a21c2` feat: structured multi-file diff in approval review gate
- `fe2a36d0` feat: workflow watcher triggers workflow transition
- `9eb53b0b` feat: agent runtime PreToolUse hook script for policy enforcement
- `df5857f5` feat: one-shot send-as-task from ThoughtsCard chat
- `f388970c` feat: server-side packet auto-dispatch loop
- `24173f2f` feat: integrate native shell-plugin-mcp for native app automation in dev builds
- `3e409e61` perf: JSONL tail-reads, cache-first actions, fingerprint optimization, sleep removal
- `947b47ac` perf: strip JSON pretty-printing from MCP server responses

## 2026-03-30

- `a58cd341` feat: native shell vibrancy polish, operator bridge fix, ghost session eviction, right panel cleanup
- `f008f584` feat: operator MCP bridge — agent runtime as o8 control surface
- `7644e08a` feat: workspace UI overhaul
- `125caca2` feat: UI polish pass

## 2026-03-29

- `52b9ba3b` feat: o8 brand mark — three-circle logo in accent blue
- `b1507b5a` feat: orchestrator loop — plan, delegate, review, approve
- `234f8c00` feat: governance engine
- `8b973087` feat: refine o8 product brief from 3-turn brainstormer session
- `75c90b23` feat: add REVIEW.md, agent delegation table in project rules, update agent descriptions
- `ca15b5ce` feat: add o8 product brief, update project rules with orchestrator model, create subagents
- `6c5d722f` feat: scrollable workspace lane tabs with transparent arrow overlays
- `cf6807ee` feat: tab scroll arrows, tool cards in Thoughts, right panel defaults to review
- `df8bff52` feat: workspace tab shows issue context + diagnostics settings tab (,)
- `4a090261` feat: one-click issue launch icon + lane-scoped review rail (,)

## 2026-03-28

- `6fc1e9c8` feat: add orchestrator MCP server, delegation tools, and agent supervisor
- `281a4906` feat: add GitHub issues to ThoughtsCard Mission Control

## 2026-03-27

- `463ff8de` feat: add translucent desktop dark mode shell
- `aac8e09d` feat: harden workspace shell and terminal sessions
- `5c765358` feat: add o8 board and restore system-wide timeline
- `578e411e` feat: move repo selection into workspace headers

## 2026-03-26

- `24b6ae1f` feat: fix branch-scoped review flow
- `c0eacdba` feat: turn workspace side panel into repo companion surface
- `6cf89a78` feat: route repo surfaces into workspace tabs

## 2026-03-25

- `ec9aee42` feat: tighten workflow lifecycle and operator recovery
- `0981e995` feat: refine desktop dark mode theme
- `39c7bb54` feat: migrate ide to fact-backed o8 recall
- `153b76ec` feat: enrich workspace cli chat parity
- `2f2b0fcf` feat: polish timeline and workspace chat surfaces
- `bf8d4e89` feat: scope agent surfaces to ide sessions
- `ca06e24b` feat: route workspace launches and github flows through broker

## 2026-03-24

- `eab62fb3` feat: ship github app broker foundation

## 2026-03-23

- `d655dabc` feat: Unified ContextualPanel — canvas tabs merged into bottom panel
- `a22ec01e` feat: Drop bundled Node (prerequisite) + bundle memory binary
- `5bb7f329` feat: WS server bundled in native shell app — terminals + chat work in production
- `36cade24` feat: GitHub App authentication — 5,450 req/hr, auto-refreshing tokens
- `1111c6e9` feat: GitHub PAT support + config lives in the user data dir/
- `c5085de2` feat: Bundle Node.js inside the app — zero-config for users
- `a9233f80` feat: Standalone server bundling for native shell — real distributable app
- `41f1f02f` feat: Inline edit
- `658912fb` feat: 'Environments' filter in files dropdown — quick access to .env files
- `0d8a7365` feat: Inline AI widget

## 2026-03-22

- `39ee35a4` feat: Tab autocomplete — AI ghost text suggestions while typing
- `20074d83` feat: Cmd+E inline AI edit
- `e813ed40` feat: Resizable files panel — drag handle between files and activity
- `67887fda` feat: Monaco Frost v2
- `c9938b4e` feat: Monaco 'o8 Frost' theme — icy light blue editor
- `6ecb9fc4` feat: Monaco Editor v3 — full IDE-grade file editing
- `96449e5f` feat: File editor v2
- `dca28235` feat: Inline file editor with Cmd+S save + files default to Changes view
- `048d3039` feat(branding): add o8 logo component + concept assets
- `610d71af` feat: In-app update banner + landing page + version sync
- `3866ea48` feat: native shell updater + GitHub Actions release workflow

## 2026-03-21

- `d98a2ae3` feat: add sidebar runtime capability layer
- `9eaeb618` feat: refine sidebar approval polish
- `50541b1d` feat: polish sidebar approvals and file actions
- `7f4399cd` feat: polish sidebar file actions
- `40d53b58` feat: add sidebar source actions
- `9002c69e` feat: unify sidebar active turn surface
- `51e28207` feat: show sidebar web source links
- `9e8e44c4` feat: enrich desktop sidebar source context
- `6347fa0f` feat: refine desktop sidebar runtime turns
- `0bbef267` feat: Conflict Resolution UI in Memory settings tab
- `7acca95f` feat: polish desktop sidebar runtime chat
- `05d04422` feat: add intent board v1
- `6e79944a` feat: unify desktop thoughts and sidebar chat rendering
- `c1af442d` feat: Codebase seeding engine — solve cold start for new users
- `78c8fc8c` feat: Unified chat send route + type fixes
- `3714eb17` perf: WebSocket RPC replaces CLI fallback — agents load in <500ms
- `b6f3b5da` feat: First Launch Setup Wizard — blue glass onboarding flow
- `7097222a` feat: Setup detection + config API for first-launch wizard
- `57c08ba1` feat: Graceful degradation when gateway unreachable
- `0ef0b44c` feat: Production polish
- `af7c99cb` feat: Blocklist guard for public changelog + project rules rule

## 2026-03-20

- `248dbb62` feat: context-aware recursive compaction — three-pass smart compression
- `3a510e6d` feat: project rules
- `3514bbf2` feat: Chat compaction
- `cf171d8b` feat: File system tools
- `698ce992` feat: Terminal command tool with three-tier safety + editable approval
- `2e69153a` feat: Chat-optimized recall — structured facts over raw chunks
- `84e34172` feat: Phase B
- `d5eea79d` feat: memory settings
- `18bead76` feat: memory settings tab — configure models, view stats
- `44cb6d5b` feat: memory recall — Phase A
- `fa565a22` feat: Steve Jobs polish — 5 UX refinements for LLM chat
- `740c2ef9` feat: Unified input container — model picker moves to bottom toolbar
- `4554694e` feat: GitHub tools for LLM chat
- `40a9b698` feat: Syntax highlighting, thinking text style, citation hover cards
- `f6e81b5e` feat: Chat history sidebar — search, star, open in new tab
- `8aa2868a` feat: Streaming code highlights, keyboard shortcuts, conversation forking
- `b0e064f1` feat: Inline citations, slash commands, Run in Terminal
- `09e2f7b9` feat: Code block actions — Apply to File + Open in Canvas
- `c1a749fe` feat: Smart follow-ups + beautiful empty state onboarding
- `6350e48d` feat: Phase 3 — Tool use with live indicators + sources
- `87387fa9` feat: Edge TTS voice playback with animated player
- `e8f6b5e0` feat: AI provider Desktop-style message action bar + proxy logging
- `3af4c3dd` feat: Chat persistence + mermaid error isolation
- `b6f2fcb3` feat: Full image support
- `9a2ef511` feat: Rich markdown renderer for LLM Chat
- `ebc58980` feat: LLM Chat Phase 1+2 — workspace context + @file attachment
- `654b36e2` feat: Add all latest AI provider models (3.1 Pro, 3 Pro, 3 Flash)
- `dba630fa` feat: configuration settings tab
- `a2571da2` feat: LLM Token Relay — provider proxy with metering
- `73cd1789` feat: LLM Chat v1 — standalone model access panel
- `829b2ac2` perf: GitHub API caching + worktrees auth fix across all routes
- `68b59ac3` perf: Kill scroll jitter — remove per-frame CSS recalculation
- `7b675e6c` feat: client abstraction — Local/Cloud/Hybrid
- `c844b850` feat: Tier 2+3 intelligence layer

## 2026-03-19

- `5701631b` feat: Repo switcher for Issues & PRs + deeper chat history
- `d25c4988` feat: Issues & PRs combined page + collapsible agents + deploy
- `52db245f` feat: Issues + Deploy Status + CI on mobile — monitoring & deciding
- `4ba2f2eb` feat: land realtime control plane and shell-first render path
- `26afd0c3` feat: Memory page
- `4ce4c01e` feat: Tap-to-reveal message actions + Telegram-style photo grids
- `d5f9fbaa` feat: Dark mode
- `f6fd5939` feat: Tier 1 UX
- `144a5f58` feat: Smooth crossfade animation between expanded header and compact pill
- `c27c9728` feat: Hide RuntimeBar when keyboard is up — clean compose
- `18e70561` feat: Auto-grow input + RuntimeBar at true bottom + frosted status bar
- `1ac71b60` feat: Compaction indicator on mobile chat — matches desktop ThoughtsCard
- `45175e53` feat: Header collapse-to-pill + repo/branch/diff in bottom footer
- `797df06f` feat: Costs page
- `e728c1da` feat: Settings + PR Reviews in Activity + panel status APIs
- `21413a25` feat: Notifications + PR Review from mobile
- `f7c7f5f4` feat: Activity Feed + Launch-to-chat + Fleet → Agents rename
- `e80ca9c7` feat: Launch Agent — fire agents from mobile
- `de47c496` feat: Fleet View — Apple-level agent dashboard for mobile
- `ec02c8a6` feat: Glass slash commands on mobile — frosted popover matching desktop
- `8c5b1e9c` feat: Speed Dial navigation — floating menu like Mister Copy Trade
- `aadb6232` feat: ThoughtsCard Apple pass

## 2026-03-18

- `bb31b56c` feat: Slash commands + glass attach popover in workspace chat
- `e3bfe466` feat: Chat V2 pass 2 — model/thinking, search, media button
- `7c85af66` feat: Chat V2
- `8478ec0a` feat: competing product-style compact agent cards + always-visible running agents
- `e6fb7355` feat: Add agent runtime + agent runtime to Open In dropdown
- `a6326d5f` feat: Open In button
- `a9ee6543` feat: Global Repo Context Bar — first-class repo selector above tabs
- `75064758` feat: Workspace Chat V1 — full chat tabs alongside terminals
- `511de9f8` feat: Dedicated Checks tab on PR viewer — competing product-style CI status
- `cbaafa8d` feat: Files tab — Changes filter dropdown
- `dba6c6fc` feat: Close remaining workspace gaps
- `7f3e7cd3` feat: Branch switching from panel — git checkout with dirty check
- `8742abff` feat: Running indicator on collapsed repo card
- `b1ee78c0` feat: Dev server launch from repo card — one-click Run/Stop
- `f26ed102` feat: Port preview pane — in-IDE iframe via proxy
- `5d1fba5c` feat: Agent ↔ Branch association — bidirectional linking
- `91d57d8c` feat: First-class ports in NavRail — auto-detect + grouped display
- `73caa0de` feat: Branch management — create, delete, cleanup
- `2181b75c` feat: Optional worktree launch + stale branch detection (,)
- `e431c0a1` feat: Expandable repo cards — branch list with worktree indicators
- `ad609f3d` feat: Colored file icons + repo-aware file tree
- `8a4eaa8e` feat: PR Review opens in canvas + remove Issues/PRs/CI tabs
- `629cc421` feat: Repo-scoped Activity
- `f69959eb` feat: Repo-aware Activity feed — selector, agent-scoped, PR merge banner
- `0c3133a7` feat: Activity feed
- `07046189` feat: Unified Activity Feed — Apple-grade timeline with GitHub data
- `9c726d5d` feat: Show all main agent surfaces + smart cron collapsing + fleet display setting
- `096f11ee` feat: Pin main agents + collapse cron sessions into single card per agent
- `935e9ead` feat: Stall detection for launched agents — 5min silence triggers warning

## 2026-03-17

- `fd5b95be` feat: Proxy localhost previews to strip frame-busting headers
- `dc767c4a` feat: Agent lifecycle
- `4ed8d0d5` feat: Live localhost preview
- `34dbbbce` feat: Live activity dots + elapsed time on terminal tabs
- `07783010` feat: Terminal tab persistence — tabs survive app restarts
- `796e1050` feat: Inline images rendered as HTML — bypass xterm IIP entirely
- `c77d971a` feat: Inline image rendering
- `0adbabb6` feat: Inline image rendering in terminal — Sixel + iTerm2 IIP support
- `c4c521b7` feat: Auto-register folders opened via picker — shows as Recent next time
- `c3b0f1f9` feat: Native folder picker
- `83d80632` feat: Open folder picker — launch CLI agents in any directory
- `457ff44c` feat: Two-step CLI picker with repo selection ( foundation)
- `c7f59308` feat: Terminal polish
- `a8ed6a3e` feat: Terminal-first workspace
- `18741a2b` feat: Live review file-change push via WS — repos + worktrees
- `90bd3250` feat: Mobile terminal surface — xterm.js on mobile + Terminal/Chat lane
- `128957d9` feat: Terminal infrastructure
- `71ad1442` feat: Launch modal UI
- `e24244b3` feat: Universal launch pipeline
- `f6c89fd3` feat: Repo registry polish
- `6a67da78` feat: Analytics page — cost dashboard with real data
- `7a17612f` feat: Agents section collapsible — same pattern as Activity
- `9df7f9b5` feat: Activity as collapsible dropdown above agent cards
- `5f3eef1a` feat: Issue assignment panel + ThoughtsCard z-index fix
- `6c049e46` feat: Active session pulse on timeline drill-down cards
- `1a6d4216` feat: Session cost tracking — real token usage + spend per session
- `b1018474` feat: Connected session panel with live SVG bezier connector
- `9bc30cef` feat: Timeline drill-down — double-click for per-agent breakdown
- `5c43c1d3` feat: Clickable PR diff on agent cards — opens PR viewer in Canvas
- `63963edc` feat: WS-driven AgentPanel + TitleBar status dot + full dedup (-6)
- `670bee13` perf: Wire WS for diff stats + remove redundant polls

## 2026-03-16

- `f2f84d67` feat: Wire WebSocket to desktop chat — real-time streaming
- `c81120e3` feat: agent runtime agents show their active repo's diff
- `43e2b39d` feat: Live Diffs for all 3 runtimes + UX fixes
- `e648662e` feat: Live Diffs — beautiful real-time code change viewer
- `5d3075c8` feat: Live Agent Output panel + agent card pulse
- `94c26159` feat: Real diff stats on main + real timeline activity bars
- `0fbccc8b` feat: Real context % for agent runtime sessions + diff stats
- `0622226b` feat: Wire real workspace data — PR status + diff stats on agent cards
- `54549618` feat: agent runtime sidebar chat
- `ce6ea21c` feat: agent runtime transcript — read session JSONL into sidebar
- `3fbfd2c6` feat: Smart naming on collapsed card dots too
- `893de1aa` feat: Better naming in agent cards
- `7e177ece` feat: agent runtime sidebar chat — send messages via CLI print mode
- `fef1a678` feat: agent runtime synthetic sessions for unmatched live processes
- `8a67d35e` feat: agent runtime sessions appear in fleet with live PID detection
- `b579ca74` feat: Status-grouped agent cards + Apple design polish
- `662ead41` feat: Full-size agent cards with everything visible
- `d6b4ac39` feat: Show heartbeat intervals on agent cards (read-only)
- `6634243c` feat: Agents tab in Settings — fleet dashboard with model editing
- `5572534e` feat: Merge WorkspacesPanel into AgentPanel — unified view
- `f857ea13` feat: WorkspacesPanel — status-grouped workspace cards
- `ae1aeef7` feat: Cmd+K keyboard shortcut to toggle Thoughts Card
- `231ecf00` feat: Context-aware suggestions in Thoughts Card
- `508b34b3` feat: Agent picker in Task chat — route to any agent
- `4d921c15` feat: Approval routing in Thoughts Card + test simulation
- `c5baa97f` feat: Task mode — mini chat inside Thoughts Card
- `2cef4fc3` feat: Thoughts Card — Issue vs Task modes + resize fix
- `ff5e6d1b` feat: Thoughts Card — resize handles + agent connection
- `818e1a6d` feat: Thoughts Card — floating glass command surface
- `00802a96` feat: Settings page with GitHub connection status
- `7b5a14ab` feat: Intent Canvas V0 — Fleet Command Center in workspace
- `6da96c2b` feat: SessionTimeline Phase 1 — hover scrubber + real data API
- `01ace93f` feat: Timeline Expanded View — full session replay in Canvas
- `bf8c66e6` feat: SessionTimeline V0 — agent activity replay bar
- `b9e4f6d3` feat: TitleBar window controls — sidebar/back/fwd/bottom/chat/settings
- `0146dedf` feat: TitleBar search is now live UniversalSearch + red settings gear
- `0c0e6313` feat: TitleBar
- `f5263e84` feat: Desktop NavRail
- `16a2b8ca` feat: Session Info Sheet
- `e54a7db8` feat: Universal search
- `df7367b3` feat: Proactive alert system — engine, context, bell, tray, toast
- `4419a11a` feat: REST API resilience

## 2026-03-15

- `b63f3eff` perf: gateway REST API client — 23ms vs 38s CLI cold-start
- `18c90fc2` feat: Heat map top-down view + fix fly-in stale closure
- `377f27c7` feat: Search dropdown with grouped clickable results
- `e4d52e59` feat: Knowledge Graph v3 — double-click fly-in + search fact nodes
- `418ef8f1` feat: Knowledge Graph v2.3 — zoom-aware labels + ambient fireflies
- `ffc54c54` feat: Knowledge Graph v2.2 — depth fog + all labels + text polish
- `b6b6dbc4` feat: Knowledge Graph v2.1 — bar gradients + floor reflections
- `8be40cd0` feat: Knowledge Graph v2
- `059b44f2` feat: Auto-refresh Knowledge Graph stats every 60s
- `2d45dca2` feat: Replace lava lamp with Interactive 3D Knowledge Graph Explorer
- `48c367e3` feat: Memory lava lamp v2
- `3f487938` feat: memory Lava Lamp — living particle visualization
- `3fbbf87d` feat: Image rendering in mobile chat + click-to-expand lightbox
- `4b0d8e0a` feat: Image rendering in chat + click-to-expand lightbox
- `638a8a7f` feat: Typing indicator — animated dots while agent is thinking
- `f47ed9f1` feat: Deployment Status (Vercel) + Git Log + Image Preview complete
- `2dc08c3d` feat: Git Log viewer + Image/Asset preview
- `ef3c82b4` feat: Issue Creator with AI enhancement (AI provider)
- `67a5f5b0` feat: Global workspace search + PR review comments with diff context
- `72e05c70` feat: CI tab in agent panel
- `7ef90f9c` feat: Changed file highlighting, clickable files, CI button
- `a1887636` feat: README viewer, CI/GitHub Actions, file diff preview
- `8dc375a4` feat: Stop button + project-scoped data + no auto-transcript popup
- `b3e9d0e0` feat: Project-scoped Issues, PRs, and Files — data follows workspace
- `5d9591dc` feat: PR Review tab + canvas viewer — full GitHub PR detail inline
- `3af091ab` feat: Commit detail viewer — click any commit in Activity tab
- `0b305939` feat: Agent panel groups by workspace — matches chat session picker
- `19b82c0b` feat: Show all agents including agent runtime/agent runtime in agent panel
- `352b261c` feat: Issue detail full-width + diff opens in canvas tab
- `ac13ffe7` feat: Drag-and-drop + paste + click-to-attach files in desktop chat
- `86d5fbac` feat: Vertical drag handle for canvas — resize workspace/canvas split
- `508f8525` feat: Contextual Canvas — bottom-half tabbed workspace
- `b4b2d9af` feat: Click agent surface → switches chat to that session
- `c1135d56` feat: Agent cards v2
- `653a1829` feat: Proper markdown rendering in issue modal
- `ab157be0` feat: Light theme + clickable issues with glass modal
- `e65be2d0` feat: Three-column layout — Agent Panel | Workspace | Chat
- `6ab46211` feat: Agent Command Center
- `e71d2edd` feat: Glass diff modal
- `e4690cb7` feat: Draggable compose bar — resize input height by dragging up
- `2c697aa0` feat: Glass modal for Mermaid diagrams — expand, zoom, pan
- `beedb8ac` feat: Mermaid diagrams on mobile — same o8 frost theme
- `8c1f6b55` feat: Styled CodeBlock + Mermaid diagram viewer
- `276067e0` feat: Transport controls — message actions morph during playback
- `0c91779a` feat: Point-to-Play
- `f0c24f64` feat: TTS Engine + Message Action Bar — Play/Copy/Retry on every message
- `1338f05e` feat: Desktop chat header — exact mobile TopBar clone
- `575541bd` feat: Desktop chat sidebar — mobile-identical chat on Dashboard v1
- `9560da73` feat: Dashboard v1
- `2b53d21f` feat: wire o8 v1.2.5 fixes — fact_ids, stale flags, real graph
- `a6bfb253` feat: grouped squad picker with expand/collapse
- `4b7698b2` feat: native shell v2 desktop shell
- `9af1036a` feat: squad picker dropdown on TopBar title tap
- `e31ca632` feat: wire memory surfaces into shell
- `6f2b969f` feat: memory Integration — all 8 issues (-)

## 2026-03-14

- `fff88386` feat: Phase 2
- `f41508ca` feat: worktree isolation Phase 1
- `c773f3d9` feat: universal runtime adapter contract + agent runtime integration
- `58091a6f` feat: code block rendering — fenced code + tool output cards
- `ae4290f3` feat: native markdown table rendering — beautiful HTML tables in chat view
- `af6455b7` feat: unified WebSocket — real-time push replaces SSE + polling
- `6078ff69` feat: PWA
- `ae4baf29` feat: virtual scrolling for transcript — DOM bloat eliminated
- `0143de0f` feat: consolidated sync API — 5 requests → 1
- `95b06c78` feat: prompt enhancement
- `cffa471b` feat: approval primitive
- `a28dbb33` feat: cost dashboard
- `9360ccbc` feat: wire json-render Renderer into mobile shell
- `ac850ea6` feat: json-render integration
- `04965e55` feat: agent runtime chat parity
- `4a282df2` feat: seamless agent runtime chat
- `2cfbf887` feat: auto-switch to launched agent runtime session
- `9d8aa6bb` feat: clean agent runtime chat view
- `ea09b713` feat: discovered agent runtime session transcript
- `07f0dcd7` feat: live process fallback
- `286f3397` feat: mobile agent runtime launch

## 2026-03-13

- `ce3a5ef7` feat: unified chat for agent runtime sessions
- `6d9cf064` feat: show all agent runtime sessions in squad (no stale filter), dedupe by branch, show branch in pills
- `59dd7471` feat: project-grouped squad rail
- `e3abcb80` feat: native streaming
- `2766c248` feat: commit summary card in diff view (zero AI
- `3a295ceb` feat: observable agents
- `53bde190` feat: squad cards
- `5efa10b5` perf: diff view
- `d6e646b9` perf: review-file 10s cache + only poll when diff open, tighter idle behavior
- `f27d88b6` perf: request dedup, 8s inbox cache, 5s transcript cache, round usedPercent, suppress hydration
- `d6f0f4ad` perf: adaptive polling (20s idle, pause on hidden tab, resume on focus), CSS containment, layout isolation
- `f9c82c32` perf: diff-and-patch transcript + snapshot — eliminate flash on idle polls
- `4384eb8f` perf: skeleton loading, lazy images, send click, API caching (3s transcript, 5s inbox)
- `8731f592` perf: smooth scroll, message fade-in, optimistic user messages, image caching, typing bubble animation
- `9887ba66` design: red send button + red typing dots — matches hamburger accent
- `c9cf14f4` design: solid red menu button, context pressure in bottom bar, doc tab apple redesign
- `1e30be56` design: full mobile UX pass
- `2715fee5` design: apple-grade controls sheet + sticky diff files survive compaction
- `b4ae629d` design: apple-grade diff polish

## 2026-03-12

- `00c14dbf` feat: surface queued agent runtime turns and clearer mobile send actions
- `f7f54ffc` feat: add quick thread switching for mobile agent runtime lane
- `b6324594` feat: make owned agent runtime mobile lane feel conversational
- `7bf408ef` feat: allow owned agent runtime interrupt on mobile
- `e480039e` feat: preload owned mobile diff context on focus
- `c740a25d` feat: extend owned agent runtime review and resume on mobile
- `b42b018d` feat: make owned review packets actionable
- `4a316a59` feat: add owned agent runtime review packets
- `6de73096` feat: surface owned agent runtime watch lane on mobile
- `e1a47bb2` feat: harden owned agent runtime lifecycle and tail views
- `dc221164` feat: add owned agent runtime launch and resume lane
- `6b7ffeea` feat: add runtime action ownership seam
- `fdc24f56` feat: promote runtime inventory and agent runtime activity detection
- `7217d071` feat: surface local agent runtime runtime discovery in desktop shell
- `b1650ee5` feat: harden mobile operator chrome and review cockpit
- `6a3cdd20` feat: add panel and terminal shells to mobile queue
- `ffd2e4a6` feat: add mobile per-file review drilldown
- `add6a8e7` feat: deepen mobile review lane and glass styling
- `8ca65c3d` feat: align desktop repo truth with live review state
- `2e94bb3c` feat: wire direct mobile actions and history

## 2026-03-11

- `bbe5dab3` feat: add mobile control inbox foundation
- `e63edc8d` feat: wire live agent runtime bridge and workflow review
- `868b012d` feat: add native desktop shell wrapper and guardrail surfaces
- `8a8b0775` feat: bootstrap command center shell and runtime contracts
