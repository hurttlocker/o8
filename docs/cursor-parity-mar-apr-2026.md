# Cursor Parity Audit — March 19 → April 13, 2026

**Compiled:** 2026-04-14
**Goal:** Pull every Cursor feature shipped in the 4-week window, cross-reference against o8's current capabilities, and produce a ranked backlog of adoption candidates.
**Window covered:** Composer 2 (Mar 19) → Self-hosted Cloud Agents (Mar 25) → 3.0 (Apr 2) → Bugbot + MCP (Apr 8) → 3.1 (Apr 13)

Cursor shipped 5 major releases in 26 days. This doc extracts every feature that isn't pure IDE-editor mechanics (tab completion, multi-cursor, vim mode, etc.) and classifies it against o8's existing governance-layer architecture.

---

## Priority P0 — Strategic, unblocks dogfood growth

### 1. Self-hosted cloud runtime adapter
**Source:** Mar 25, 2026 — "Self-Hosted Cloud Agents"
**What Cursor did:** Workers are CLI processes customers run on their own infra (k8s, VM, bare metal). Each worker opens an **outbound-only HTTPS connection** to Cursor's cloud; planning logic stays centralized, execution stays in the customer's network. Service account API keys, Helm chart + fleet API, early adopters Brex and Notion. Limits: 10 workers/user, 50 workers/team.

**o8 parity:** Missing. o8 executes Codex and Claude Code entirely locally in `~/.cortex-worktrees/*`. The runtime adapter interface (`src/lib/runtimes/`) is the natural extension point. Existing issue #513 tracks Vercel Open Agents as one cloud path; Cursor's self-hosted model is a different path worth supporting in parallel because it preserves data residency.

**Adoption path:** New `cloud-adapter.ts` alongside `codex.ts` and `claude-code.ts`. Accept pool endpoint + API key. Worker pool talks outbound to the o8 app. Governance (lanes, approvals, reaper, merged banner) is runtime-agnostic and works unchanged.

---

### 2. Unified Agents Window
**Source:** Apr 2, 2026 — "3.0"
**What Cursor did:** A dedicated standalone workspace accessible via `Cmd+Shift+P → Agents Window` that lists *all* agents from *all* origins in one sidebar — desktop, mobile, Slack, GitHub, Linear, cloud. Each row shows origin tag, status chip, live activity. Toggles side-by-side with the editor or replaces it entirely.

**o8 parity:** Partial. o8 has SessionVisualizer (horizontal strip), OrchestratorTab, runtime adapters per surface. Missing: the unified "all agents, all sources, one pane" live sidebar. Today an operator must context-switch across tabs to see parallel work.

**Adoption path:** Extend the existing left sidebar (RepoRegistry) or add a new NavRail surface. Agents grouped by origin with live status. Backed by the existing lane registry + session inventory. The governance story (audit + approval + archive) is what makes o8's version differentiated vs. Cursor's.

---

## Priority P1 — High-impact UX wins

### 3. Tiled multi-agent view
**Source:** Apr 13, 2026 — "3.1" Tiled Layout
**What Cursor did:** Resizable/draggable pane layout for running multiple agents side-by-side in the Agents Window. Per-pane expand/collapse, navigation keybindings, layout persists.

**o8 parity:** Partial. SessionVisualizer shows active sessions in a horizontal strip but doesn't let the operator tile N chats simultaneously. WorkspaceTerminal already has a tile layout system (TileContainer, tile-layout hooks) that could absorb this.

**Adoption path:** Teach WorkspaceTerminal's tile layout to accept multiple `chat` tab panes at once and lay them out in a grid. Persist per-workspace.

---

### 4. `/best-of-n` parallel model comparison
**Source:** Apr 2, 2026 — "3.0"
**What Cursor did:** Syntax: `/best-of-n sonnet, gpt, composer fix the flaky logout test`. Spawns the identical task across N models in parallel worktrees, then a parent agent writes commentary comparing outcomes. Operator picks the best or merges pieces.

**o8 parity:** Missing. o8 dispatches one packet → one worktree → one result. No native "race the models" flow.

**Adoption path:** New `comparison_models: string[]` field on the packet schema. Dispatch fans out N worktrees via existing dispatch pipeline. A meta-agent (orchestrator Claude in a follow-up step) reads the N diffs and produces comparison commentary. Approval UI renders N cards with "Pick this one" / "Merge parts" actions. Natural for o8's multi-repo multi-agent story.

---

### 5. Learned review rules
**Source:** Apr 8, 2026 — "Bugbot Learned Rules"
**What Cursor did:** Bugbot samples three feedback signals from merged PRs — reaction downvotes, dev replies explaining false positives, reviewer gaps where humans caught what Bugbot missed. Candidate rules feed into a pipeline that auto-promotes high-signal rules and auto-disables low-signal ones. Stored in `.cursor/BUGBOT.md` (repo) + dashboard (team). 44k+ learned rules across 110k+ repos. Resolution rate climbed 52% → 78% in 9 months.

**o8 parity:** Missing. o8 has approvals + lane merges but no self-learning loop on dispatch quality. Every packet dispatch starts from the same prompt template regardless of what worked last time.

**Adoption path:** Collect signals on every lane merge: approved / rejected / follow-up commits / reviewer comments. Feed into a rules store keyed by repo + packet type. Surface "learned rules" in the dispatch wizard so the orchestrator sees "last 5 packets like this failed because X — add this guard to the prompt." The signal channel is a natural extension of the session ledger from Cortex v2.

---

### 6. External MCP servers as orchestrator context
**Source:** Apr 8, 2026 — "Bugbot MCP Support"
**What Cursor did:** Teams/Enterprise can register MCP servers in the Bugbot dashboard. Bugbot connects (stdio or HTTP), discovers capabilities, uses them as **context sources** during PR review. One-click OAuth for authenticated servers. Example: Slack context, test result context, deployment log context.

**o8 parity:** Partial. o8's operator MCP server exposes tools FROM o8 TO Claude Desktop. The reverse direction (orchestrator Claude *consuming* external MCP servers for context) is not wired. Cursor's implementation is narrow but exactly what o8 needs.

**Adoption path:** Extend the orchestrator session spawn to optionally attach external MCP servers. Store server configs per-team in SQLite. Surface in Settings → MCP tab alongside the existing install cards. Natural ecosystem play — the more MCP servers a team plugs in, the smarter orchestrator dispatches get.

---

## Priority P2 — Refinements that fit the existing surface

### 7. Design Mode — visual UI annotation for agent feedback
**Source:** Apr 2, 2026 — "3.0"
**What Cursor did:** Browser-based UI annotation layer. Keyboard shortcuts: `⌘+Shift+D` toggle, `Shift+drag` select area, `⌘+L` add to chat, `⌥+click` add to input. Agent sees the selected UI region and iterates from visual feedback.

**o8 parity:** Partial. `o8_view_screenshot` + `o8_view_snapshot` give the MCP layer full access but there's no visual markup layer the operator can paint on.

**Adoption path:** SVG overlay on top of `o8_view_screenshot` capture. `⌘+L` grabs the selection rectangle, crops the screenshot, attaches it to the next packet as context. Builds directly on the webview tool family shipped this week.

---

### 8. Persist agent plans separately from transcripts
**Source:** Apr 2, 2026 — "3.0" Shared Chat with Plans
**What Cursor did:** Plans now surface alongside transcripts in shared chats. Past transcripts appear in @-mention search results.

**o8 parity:** Partial. o8 has chat history + session ledger but doesn't distinguish "plan phase" from "execution phase" in the transcript.

**Adoption path:** Extract the first orchestrator response (plan) into a `plan_text` field on the session ledger. Render as a collapsed card above the execution transcript in the history drawer. Lightweight change, improves audit.

---

### 9. Auto-capture screenshots at lane review boundaries
**Source:** Apr 2, 2026 — "3.0" Agent Verification via Screenshots
**What Cursor did:** Cloud agents produce demo videos + screenshots for user review before merge.

**o8 parity:** Partial. `o8_view_screenshot` exists, lanes + approvals exist, but they don't meet — there's no auto-capture at dispatch/merge boundaries to populate approval cards.

**Adoption path:** On lane transition into `reviewing`, fire `o8_view_screenshot` via the operator MCP and attach the PNG to the lane event payload. Render in the approval card. Screenshot verification is a core trust primitive for the governance layer.

---

### 10. Branch selection wizard in packet dispatch
**Source:** Apr 13, 2026 — "3.1" Branch Selection in Empty State
**What Cursor did:** Pre-populate branch before launching cloud agents. Search/select UI before spin-up so operators don't ship to the wrong branch and then re-target.

**o8 parity:** Partial. ThoughtsMissionPanel has Repo/Branch fields in the Issues-style metadata row, but they're edited after the fact. Dispatch flow is: click launch → pick repo → commit → figure out branch after.

**Adoption path:** Add a branch picker to the packet creation flow before dispatch. Pull branches from the repo registry + live git. Default to current branch. Makes wrong-branch dispatches a category of bug that can't happen.

---

### 11. Export orchestrator thread to markdown
**Source:** Apr 13, 2026 — "3.1" Plan Tabs Document Behaviors
**What Cursor did:** Loading states, dirty-state tracking, save/copy/export plans to markdown.

**o8 parity:** Partial. Orchestrator threads persist to SQLite but there's no export path. Sharing a decision transcript today means screenshots or copy-paste.

**Adoption path:** Add a "Copy thread as markdown" action to the history sidebar row. Include the plan + transcript + linked packets + final decisions. Low effort, good ROI for audit and sharing.

---

### 12. Streaming diff preview with partial apply in chat
**Source:** Mar 19, 2026 — "Composer 2" (adoptable pattern, not the model)
**What Cursor did:** Composer 2 streams targeted diffs instead of regenerating full files. Users watch the diff arrive, can interrupt or cherry-pick.

**o8 parity:** Missing. o8's chat panel (ThoughtsChatPanel) renders code blocks but doesn't treat them as apply-able diffs.

**Adoption path:** When a chat response includes a code block tagged as a diff, render a diff card with an "Apply" button that routes through the existing lane/worktree system. Works with any model — the value is in the UX, not Cursor's proprietary Composer 2.

---

## Not applicable (IDE mechanics, foundation model work, single-tenant features)

- Voice input (Cursor 3.1) — o8 is not an editor
- File search filters (3.1) — no file explorer in o8
- Diff-to-file navigation (3.1) — no editor
- Design Mode arrow-key nav (3.1) — editor feature
- Cmd-K results (3.1) — partial, not urgent
- macOS text anti-aliasing (3.1) — already shipped
- Composer 2 itself (Mar 19) — foundation model, not replicable
- Cloud agent team permissions (3.0) — o8 is desktop-local
- Audit logging with dir group names (3.0) — only matters at SaaS scale
- Attribution control (3.0) — no branding mgmt
- Tab Bar full-width (3.0) — already shipped
- Enterprise plugin defaults (3.0) — no enterprise governance layer yet
- CI reliability fixes (Apr 8) — review happens in-app, not in GitHub checks
- Settings UI redesign (Apr 8) — partial, not urgent

---

## Already shipped in o8

- New sessions default to preferred project (runtime adapter + workspace persistence)
- Instant follow-up sends (ThoughtsChatPanel is already stream-aware)
- `/worktree` isolation (runtime adapter + `prepareLaunchWorktree`)
- Multi-root workspace (fleet model + repo-aligned workspaces)
- MCP structured content (operator MCP server already supports rich responses)
- Large-file diff rendering (Canvas already streams)

---

## Strategic commentary

Cursor shipped 5 major releases in 26 days. The velocity comes from a focused product surface: they're iterating on a single IDE with a proprietary model and a cloud backend. o8's advantage is the governance layer — lanes, approvals, organizational memory, multi-surface agent coordination. **Cursor can't ship governance without breaking their single-user IDE story. o8 can't ship a proprietary model without training infrastructure.** The adoption candidates above are exactly the surfaces where o8's architecture lets us pick up the Cursor UX wins without paying the Cursor tradeoffs.

Priority order if we had to pick: #5 learned rules + #1 cloud runtime are the two that turn o8 from "governance for one operator" into "governance for a team." #2 unified agents window and #4 best-of-n are the two that make the daily dogfood loop feel fast enough to compete with Cursor's raw shipping velocity. Everything else is refinement.
