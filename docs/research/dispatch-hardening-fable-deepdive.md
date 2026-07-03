# Deep-Dive Prompt: Harden o8's Dispatch → Work → Review Pipeline to Apple/Anthropic Grade

**For:** Fable 5 (or the strongest available reasoning model), running as a 10,000-ft auditor over the o8 codebase at `/Users/marquisehurtt/o8`.
**Author of the first pass:** Fable 5, inline, 2026-07-03 (this session). This prompt hands off *my own work* for adversarial review — assume nothing I fixed is actually correct until you've traced it.
**Repo:** Next.js 16 + Tauri v2 desktop app. `main` is current; run `git log --oneline -25` for the fixes referenced below.
**Read first:** the vault page `~/Obsidian/cashcoldgame-wiki/concepts/o8-dispatch-pipeline-reliability.md` (the incident map) and `CLAUDE.md` → "Orchestrator Architecture", "Merge-failure escalation chain", and the reaper/lifecycle sections.

---

## Your mission

o8's core value proposition is: **the operator (or an orchestrator) dispatches coding work to Codex/Gemini worker agents in isolated worktrees, and o8 governs it seamlessly to a reviewed merge.** This is the surface most users touch. It has been buggy — work got silently buried, phantom missions assassinated live lanes, workers launched into cold backends, the UI showed stale lanes, and completed-via-PR lanes never closed. I did a root-fix pass this session (commits on `main`, 2026-07-03). **Your job: verify my fixes are correct AND complete, find what I missed, and produce a ranked, concrete hardening plan that takes this pipeline to Apple/Anthropic reliability grade — the kind where a first-time stranger dispatches ten packets and every one flows to review or a clear operator decision with zero manual archaeology.**

Be adversarial. Trace the real call paths, not the comments. Where I claim a fix, find the case it doesn't cover. Assume scale: hundreds of active lanes, dozens of concurrent dispatches, flaky worker processes, mid-mission app restarts.

## What I fixed this session (verify each — trust nothing)

Trace each against its real entry point and tell me where it's wrong or incomplete:

1. **Silent-exit re-triage burial.** `src/lib/supervisor/silent-exit-detector.ts` — removed `reviewing` from `INTERESTING_LANE_STATUSES`, and removed `silent_exit_work_present` from `DEAD_LANE_EVENT_LABELS` (the 30-min archiver `archiveTerminallyDeadLanes`). Claim: completed work can never be reclassified as a silent exit and auto-archived. **Verify:** is there any *other* path that can archive a `reviewing` lane with committed work? (Check `worktree-reaper.ts`, `reaper.ts` `archiveStaleDeadLanes`, and `branch-cleanup.ts`.) Are there races between the supervisor's `agent_completed → reviewing` transition (`ws-server.ts` ~5551) and the silent-exit tick?

2. **Inline mission number collision.** `operator-mission-service/shared.ts` `nextInlineIssueNumbers()` (time-based unique) + both creators (`spawn-prompt.ts`, `mcp/operator-handlers/mission.ts`). Claim: inline missions no longer collide on issue number, so branch-cleanup can't archive a prior mission's live lanes. **Verify:** the branch SLUG is still title-derived (`inline/{slug}`) — two different missions with the same task title still collide on branch target. Is that still a lane-assassination vector? Trace `probeExistingBranch` → `archiveLanesForBranch`.

3. **Active-lane reset guard.** `branch-cleanup.ts` — only an explicit `existingBranchPolicy:'reset'` may clear ACTIVE lanes; derived resets now throw instead. **Verify:** does `create_mission`'s default `existingBranchPolicy:'auto'` now correctly REFUSE to nuke a live lane, and does the caller surface that error usefully instead of failing the whole mission opaquely?

4. **Review-ready notification.** `src/lib/lane/lifecycle.ts` — `notifyReviewReady` push on the `→ reviewing` edge from `publishLaneLifecycleEvent`. **Verify:** does this fire on EVERY path into `reviewing` (agent_completed, silent-exit salvage, zombie-reap salvage, base-moved recovery)? Any double-fire? Does it reach an external MCP orchestrator, or only push/WS?

5. **Updater relaunch zombie.** `src-tauri/src/lib.rs` `restart_app` command (kills `kill_tracked_children()` then `app.restart()`) + `UpdateCard.tsx` invokes it. **Verify (Rust):** does `kill_tracked_children()` actually cover the next-server AND ws-server children in a signed build? Is the 300ms socket-release window reliable, or should the new instance's port-probe be the real guarantee? Is there a cleaner Tauri-native lifecycle hook than a bespoke command?

6. **Cold-start dispatch gate.** `src/lib/runtimes/shared/dispatch-readiness.ts` + `owned-session/store.ts` `launch()`. Claim: workers wait for `/api/setup/status` before spawning. **Verify:** is `/api/setup/status` the right readiness signal — does a 200 there actually mean the MCP endpoints the worker needs (operator MCP :18795, cortex) are reachable? Or could it be 200 while MCP is still cold? What's the real readiness invariant?

7. **Self-review stall tuning.** `self-review-stall-guard.ts` — don't `signal-stall` when `hasDiffAgainstBase`; salvage committed+idle to `force-review`. **Verify:** the `force-review` path's downstream (`ws-server.ts handleCodexSelfReviewProgress`) — does force-review actually commit the dirty tail and route to `reviewing`, or can it lose an uncommitted final edit?

8. **Shared owned-session index (perf).** `src/lib/runtimes/shared/owned-session-index.ts` — 2s-TTL memoized readdir shared by silent-exit + reaper. **Verify:** is a 2s TTL safe against every consumer's decision window? Any consumer that needs sub-2s freshness? Is the memo keyed correctly (per-root), and does `resetOwnedSessionIndex` get called anywhere it shouldn't in prod?

## The big open architectural gaps I found but did NOT fix (design these)

These need your architectural judgment, not a quick patch. For each: root-cause it, propose the correct design, and estimate blast radius.

**A. The single current-mission pointer (the deepest flaw).** `create_mission` wholesale `Object.assign`-replaces ONE file-backed mission object (`operator-mission-service/mission.ts` ~200, under the control-plane lock). In-flight lanes of a replaced mission lose all orchestrator visibility (`get_mission_status`, the headless dispatch tick, the UI packet list only see the current mission's packets) and age until a reaper archives them. **This is why "dispatch a second mission" orphans the first.** Design the fix: a multi-mission registry? A refusal to replace a mission with live lanes? Per-mission lane namespaces? What's the migration path from the single-pointer model, and what UI/MCP surfaces need to change?

**B. Merged-via-PR lanes never close (the stale-UI generator).** In PR-only dogfood mode, `approve_and_merge` returns "open a PR, human merges" — but **nothing reconciles a merged PR back to the lane.** The lane sits in `reviewing` forever until a reaper archives it (and if the PR branch name differs from the lane's tracked branch — which happens — even the merge-base reaper never catches it). Every packet shipped this way is a stale `reviewing` row + a stale sidebar/tab entry. **Design:** how should a lane learn its work merged? Poll GitHub PR state? A webhook? Reconcile on `git fetch` when the lane's commits become ancestors of `main`? What closes the lane, cleans the worktree, and clears the UI tab — automatically, at Apple grade?

**C. Live-but-stuck worker has no salvage.** The silent-exit/zombie salvage paths only trigger on a DEAD process. A worker that's ALIVE but wedged (spun ~20 min in a self-review loop this session; also the codex-CLI-deadlock class from 2026-07-02) is never salvaged — committed work can sit unreviewed indefinitely. The `self_review_stall_detected` watchdog signals but (below its cap) only escalates to the orchestrator; it doesn't force-surface the committed work after a hard deadline. **Design:** the full liveness taxonomy (dead / alive-and-working / alive-but-wedged / alive-but-done-and-over-reviewing) and the correct action for each, with hard deadlines that never leave committed work unsurfaced.

**D. Stale UI in general.** Visual audit this session (via `mcp__o8__o8_view_screenshot`) showed: a "Spawned agents" sidebar entry for an already-merged packet, an "Approve" button + "Agent working" for merged work, and (historically) red-dot `inline: threadless task` phantom rows. The DB had 10 `failed` phantom lanes + 2 `reviewing` lanes for merged PRs. I swept them manually. **Design:** the desktop's lane/packet/tab list should be a pure projection of governed lane truth with automatic cleanup on terminal states — no manual sweeps, no stale rows ever. Where does the UI read lane state, and where's the cleanup gap? (Left sidebar `LeftPanelProjectFocus`/AgentsTab, the workspace tabs, `OrchestratorDataProvider`.)

## The token-economics thread (do NOT lose this — it's the product)

o8's differentiator (see `~/Obsidian/cashcoldgame-wiki/concepts/o8-fable-mode.md` and `o8-dispatch-pipeline-reliability.md`): the metered orchestrator (Fable/Claude) makes *decisions only* while fixed-cost workers do bulk. Two open items directly serve this and touch dispatch:
- **Founders-tier Brain not wired:** `src/lib/cortex/qa/llm/inference-route.ts` `resolveInferenceRoute` (the license-server managed proxy, model class `google/gemini-2.5-flash-lite`) has ZERO consumers — so the founders/pro fast-Brain perk isn't actually used; the QA cascade (`compose-class-a.ts`) only reaches OpenRouter with a BYO key. For **codex-orchestrator** users without a Claude sub, the warm Sonnet-5 Brain path (Fable's advantage) is unavailable — they need the managed founders tier, and sub-only users should fall back to codex-CLI compose at LOW reasoning effort. **When you assess dispatch reliability, factor in: every codex-orchestrator turn wants a fast, cheap, cited Brain answer, and the wiring to deliver it is missing.**
- **Brain-first codex orchestrator** just shipped (#1351) — verify it actually asks the Brain on every turn and that the answer resolves through the fastest available tier for the user's plan.

## Deliverable I want from you

1. **Verification verdict** on fixes 1–8: for each, CONFIRMED-correct / INCOMPLETE (name the uncovered case) / WRONG (name the failure), with the file:line trace that proves it.
2. **Root-cause + design** for gaps A–D: the correct architecture, ranked by operator-impact, with blast radius and a suggested implementation order.
3. **A ranked hardening backlog** — the ordered list of packets to dispatch (each scoped tightly enough for one Codex worker, with the anchor files) that takes dispatch to Apple/Anthropic grade. Mark which are safe to dispatch to a worker vs which need a human/Fable to design first.
4. **The reliability invariants** this pipeline should guarantee, stated as testable properties (e.g. "committed work reaches `reviewing` or an operator card within N seconds of worker exit, always" / "no lane is ever archived while its commits are unmerged and unreviewed" / "the UI lane list equals the set of non-terminal governed lanes, always"). These become the contract tests.
5. **Perf/scale review** of the timer sweepers (silent-exit, zombie reaper, worktree reaper, supervisor poll) at hundreds of lanes — confirm my shared-index win, find the next O(n) offender (the worktree reaper's per-lane `git merge-base` subprocess is a candidate), and propose the memoization/coalescing plan.

Trace everything. Cite file:line. Assume I was wrong until the code proves I wasn't. Ship me the plan that makes dispatch boring — the highest compliment.
