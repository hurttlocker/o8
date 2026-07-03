# Dispatch Hardening Audit — Adversarial Verification + Design Pass

**Auditor:** Fable 5, 2026-07-03, executing `docs/research/dispatch-hardening-fable-deepdive.md` via six parallel read-only tracer agents + inline adjudication.
**Method:** every fix assumed wrong until the code proved otherwise; all claims traced to file:line by agents with no write access.

---

## 1. Verification verdicts (fixes 1–8)

| # | Fix | Verdict | The case it misses |
|---|---|---|---|
| 1 | Silent-exit re-triage burial | **CONFIRMED** | None. `INTERESTING_LANE_STATUSES={running,awaiting_input}` (silent-exit-detector.ts:81-84), `silent_exit_work_present` out of `DEAD_LANE_EVENT_LABELS` (:420-424), contract-pinned (silent-exit-detector.test.ts:12-22). Race analysis: whichever of supervisor/detector wins the tick, the lane lands `reviewing` and is never archived. |
| 2 | Inline mission number collision | **INCOMPLETE** | The PRIMARY creator — MCP `create_mission` — never calls `nextInlineIssueNumbers()`; it reimplements numbering at `operator-handlers/mission.ts:829` **without** the sequence disambiguator, so two calls in the same ms collide. `targets/dispatch/route.ts:54` still hardcodes 90001. The shared helper itself is not concurrency-proof (ms timestamp + per-process counter %10, no lock — cross-process same-ms collides; 11th batch/ms wraps). |
| 3 | Active-lane reset guard | **CONFIRMED, one bypass** | Guard at branch-cleanup.ts:354 works for the create path: `auto` throws a clean, actionable error naming laneId(status)+remedy, surfaced verbatim through the MCP tool result. BYPASS: `reset.ts:85` and `:223` (`reset_packet --clearWorktree`) call `cleanupIssueBranch` directly, skipping the guard → `archiveLanesForBranch` archives every non-terminal lane on the branch. Caveat: one collision aborts the whole mission, not just the colliding packet. |
| 4 | Review-ready notification | **CONFIRMED** | All nine entry paths into `reviewing` flow through `publishLaneLifecycleEvent` (lifecycle.ts:49) — agent_completed, force-review, silent-exit salvage, zombie salvage, base-moved/rebase (worktree-side-merge.ts ×7 sites), heal-bot, commands, apply-diff, reconcile. Edge-guarded against reviewing→reviewing re-notify; genuine re-entry re-notifies with Web Push tag collapse (`review-ready-${laneId}`). MCP orchestrators are reached by the lane-event ring buffer, not push — correct split. |
| 5 | Updater relaunch zombie | **CONFIRMED** | Both port-holders registered (lib.rs:4559, :859) and killed by `restart_app` (lib.rs:1289 → sidecar_lifecycle.rs:25). Kill is per-PID not process-group, but detached grandchildren (setsid workers, tmux) don't hold 3001/3002 — port release unaffected. The 300ms sleep is best-effort; the REAL guarantee is the new instance's free-port probe + TIME_WAIT-aware boot orphan-reap, and nothing caches the old port (consumers follow `~/.o8/api-port`). First update FROM a pre-fix build inherently uses the old path — one manual babysit, no mitigation exists. |
| 6 | Cold-start dispatch gate | **INCOMPLETE** | `/api/setup/status` is a **static stub** `{ok, ready:true}` — touches no DB, no MCP socket, no ws-server, and skips the auth gate (ALLOWLIST_READ_ONLY). A 200 proves only that Next.js accepts HTTP: **liveness, not readiness.** It closes the original ECONNREFUSED class (and the gate itself is sound: 1.5s timeout, retry ≤20s, throws `DispatchBackendNotReadyError`, single chokepoint at owned-session store.ts:584 that every dispatch path funnels through; steer bypasses correctly as a warm resume). The real worker invariant — gated /api serving against a migrated DB + ws-server + operator MCP socket — is unproven by this probe. |
| 7 | Self-review stall tuning | **CONFIRMED, one residual** | Signal-stall now requires `!hasDiffAgainstBase` (self-review-stall-guard.ts:148); committed work falls to force-review salvage (:182). **No lost dirty tail:** `forceCodexSelfReviewToReview` (ws-server.ts:604) runs `autoCommitCompletionWorktree` (`git add -A` + commit, completion-verification.ts:131) BEFORE routing to reviewing. Residual: the alarm keys on `runningMs` = total elapsed (:135), not idle — a worker actively writing uncommitted for 10 min still trips it (bounded: escalation, not a kill). |
| 8 | Shared owned-session index | **CONFIRMED** | Per-root memo, 2s TTL, partial-write-safe (skip on read/parse failure = conservative "gone"). Both former readdir sites converted (reaper.ts:70, silent-exit-detector.ts:107). Both consumers are pre-gated on 90s/45s staleness windows and only ACT on dead — stale-alive is a no-op, so the #1292 resurrection class is unreachable. `resetOwnedSessionIndex` never called in prod. No consumer needs sub-2s freshness. |

**Score: 5 confirmed, 2 incomplete (2, 6), 1 confirmed-with-bypass (3).** The incomplete pair share a shape: the fix landed at ONE call site while the primary path kept its own copy (fix 2), or probed a proxy for the invariant instead of the invariant (fix 6).

---

## 2. Architectural gaps A–D: root cause + design (ranked by operator impact)

### A. Single current-mission pointer — rank 1 (breaks the core mental model)

**Root cause (confirmed):** one file `~/.o8/orchestrator-state.json {version:1, mission}` (control-plane.ts:38-73); `createMission` Object.assigns over it (operator-mission-service/mission.ts:200-204) **and calls `archiveMissionsExcept`, actively orphaning the prior mission**. The headless dispatch tick (headless-loop.ts:215-239), `/api/orchestrator/state` (state/route.ts:84), and the #596 client-merge guard all read the singleton. Load-bearing schema fact: **`lanes` has `packetId` but no `missionId`** (schema.ts:390-417) — lanes can't be grouped by mission at all. The SQLite `missions` mirror partially mitigates (explicit-id `get_mission_status` works historically) but active lifecycle does not.

**Design:** keyed mission registry with an active set, reusing the SQLite mirror as durable store.
- `missions/<id>.json` per mission + `activeMissionIds`; `withLockedState` gains a missionId param defaulting to the sole active mission (MCP signatures frozen: no-id → most-recent active).
- **Keystone: add + stamp `lanes.missionId`** (migration, invisible, ships first — also feeds gap D grouping).
- Dispatch tick loops the active set; #596 guard matches ANY active mission; `archiveMissionsExcept` deleted.
- Rejected: refuse-replace (blocks the legitimate second-sprint intent); namespaces without a registry (tick still reads one pointer); pure-DB big-bang (right end-state, wrong single ship).
- Staging: (1) lanes.missionId → (2) registry behind flag, loop iterates → (3) UI multi-mission list → (4) retire singleton. **Blast: HIGH** — touches the per-tick control-plane lock shared with the merge path; keep ONE process-wide lock through ship 2.

### B. Merged-via-PR lanes never close — rank 2 (the steady stale-UI generator)

**Root cause (confirmed, sharper than hypothesized):** the create-PR command pushes, runs `gh pr create`, sets `reviewing` (lane/commands.ts:762-777) — and the PR URL is returned in a note but **never persisted; no prNumber on the lane**. The only closer is the reaper's `git merge-base --is-ancestor` (worktree-reaper.ts:35-53,116-127), which is defeated by **squash/rebase merges rewriting the SHA — GitHub's default** — and by a desktop that never fast-forwards local main. Branch rename is a red herring (ancestry is by object).

**Design:** reconcile from the GitHub **mirror**, not git ancestry. The plumbing exists: `github_pull_requests` already carries state/mergedAt/headRefName/number (schema.ts:320-340), synced by github-broker/sync.ts:143-228.
- Stamp `lanes.prNumber` at pr_created; a reaper-folded tick checks every `reviewing` lane with a prNumber; mirror `mergedAt != null` → `archiveLane` (worktree + branch + UI cleared). Closes squash merges because it trusts GitHub's verdict.
- **Require `mergedAt`, never `closed`** — a rejected PR must not auto-archive live work.
- Fallbacks: `--is-ancestor <lane HEAD> origin/<base>` on fetch for merge-commit PRs; webhooks opportunistic only (desktop has no public endpoint). Legacy lanes match by headRefName + repoFullName.
- Staging: (1) stamp prNumber (no behavior change) → (2) reconciler → (3) fallbacks. **Blast: LOW-MED.** Ships in parallel with A's keystone.

### C. Live-but-stuck worker salvage — rank 3 (violates the core invariant)

**Root cause (confirmed):** every net requires the process dead or emitting. The only wedged-worker detector, `probeSelfReviewStall`, is **event-driven on transcript deltas** (ws-server.ts:5288 → :483) — a silently wedged live worker never fires it and no timer drives it. Zombie reaper needs `probe.alive===false` (reaper.ts:207); silent-exit skips `alive===true` (silent-exit-detector.ts:477); heartbeat is a self-report.

**The liveness taxonomy (the spec):**

| State | Signal | Hard deadline | Action |
|---|---|---|---|
| dead | probe alive===false | 45s quiet | existing triage → commit + reviewing |
| alive + working | worktree signature / transcript mtime advancing | — | none |
| alive + wedged | alive AND signature+transcript BOTH frozen | 10 min | interrupt; committed diff → force reviewing; else operator card |
| alive + over-reviewing | alive + hasDiffAgainstBase + no edits | 5 min idle | force reviewing — driven by a TIMER, not progress events |

False-positive guard (xhigh workers legitimately think 3+ min between writes): require BOTH signature-frozen AND no transcript growth before the wedged branch fires. Salvage reuses `forceCodexSelfReviewToReview` (ws-server.ts:604 — already commits the dirty tail, per fix-7 verification). Anchors: self-review-stall-guard.ts (timer entry), silent-exit-detector.ts:457 (wedged branch in the tick), reaper.ts (extend to alive+stale). Also fold in the fix-7 residual: alarm on idle time, not total elapsed.

### D. Stale UI as pure projection — rank 4 (chronic, now structurally explained)

**Root cause (confirmed):** two stores, one-directional reconcile. Sidebar and workspace tabs project the **mission-packet store** (localStorage + `/api/orchestrator/state`), not lanes (AgentsTab.tsx:38 → `isLivePacket`, utils.ts:102). `reconcileOrchestratorMissionState` (store.ts:774) maps lane→packet only when a domain lane EXISTS (:861); when a terminal lane is archived/removed, the packet keeps its last persisted status forever (:900) → phantom "Agent working" + Approve. Out-of-band terminals (external PR merge, resets without lifecycle events) never flip the packet — that's why the manual sweep was needed, and why the **uncommitted point-fix at useWorkspaceTerminal.ts:910** (closing reset-orphaned tabs) exists: it patches one symptom of this class.

**Design:** (1) lanes table is the single source of truth — `/api/orchestrator/state` derives packet live-status from `SELECT` non-terminal governed lanes, no cached packet.status; (2) a server-side structural reconciliation sweep (PR-merged / branch-gone / worktree-gone → lane archived + packet released + lane-lifecycle broadcast, ws-server.ts:4362) makes phantoms impossible; (3) every surface subscribes to lane-lifecycle (useSessionState.ts:95 already does) and re-derives — terminal transitions auto-clear tabs and rows, retiring per-instance close listeners. Note: gaps B and C feed this sweep; D is mostly complete once they land plus the derive-don't-cache change.

**The unifying pattern across A–D:** lifecycle trusting a local singleton (mission file, packet store) or local git while the durable store already exists (SQLite missions mirror, github_pull_requests, lanes table). Every fix is "make lifecycle read the durable store, keyed by an id currently missing from `lanes`" (missionId, prNumber).

---

## 3. Token-economics thread — two claims REFUTED, one real gap

The adversarial pass cut both ways; the deep-dive prompt's own claims were wrong twice:

1. **"resolveInferenceRoute has zero consumers" — REFUTED (misnamed).** The real function `resolveOpenRouterRoute` (inference-route.ts:144) IS consumed (openrouter-adapter.ts:168) and routes plan-token → managed proxy FIRST (founder/pro/team), then local, then BYO. The founders-tier fast Brain is wired.
2. **"Compose only reaches OpenRouter with a BYO key" — REFUTED.** `tryComposeOpenRouter` (compose-class-a.ts:296) goes proxy-token-first; `managedInferenceEnabled` (:236) promotes founders to the fastest tier automatically. BYOK gating is opt-in (`O8_BYOK_REQUIRED=1`, off by default).
3. **The real gap:** a codex-CLI compose tier EXISTS (compose-class-a.ts:275) but runs at **default effort, not LOW** — no `model_reasoning_effort` in the QA path, so the sub-only fallback is a ~15s answer. The intended cheap-fast tier doesn't exist yet.
4. **#1351 brain-first is a prompt nudge, not a mechanism** — `buildCodexOrchestratorPrompt` injects "use cortex_ask FIRST" every turn (codex.ts:34) but nothing enforces it. Resolution per plan is correct when called: founders → proxy flash-lite ~0.5s; Claude-sub → warm Haiku CLI; codex-only → slow codex CLI (see gap above).

---

## 4. Reliability invariants (the contract tests)

Each stated as a testable property; each maps to real-path tests per the reachability doctrine.

- **I1 — No burial:** committed work reaches `reviewing` or an operator card within 15 minutes of the worker's last progress, **regardless of process liveness**. (Gap C closes the alive-wedged hole; fixes 1/7 close the dead paths.)
- **I2 — No assassination:** no lane is ever archived while its commits are unmerged and unreviewed, except by an explicit operator action that names that lane. (Fix 3 + the reset.ts bypass + branch-slug uniqueness.)
- **I3 — Always heard:** every edge into `reviewing` fires exactly one operator notification; re-entry re-notifies; push-tag collapses spam. (Holds today — pin it.)
- **I4 — Collision-free birth:** two concurrent `create_mission` calls never produce colliding issue numbers OR branch names. (Fix-2 completion + number-in-slug.)
- **I5 — Missions are additive:** dispatching mission N+1 never reduces the visibility or lifecycle guarantees of mission N's live lanes. (Gap A.)
- **I6 — Merged means closed:** a lane whose PR has `mergedAt` reaches archived (worktree pruned, tab cleared) within one reconcile interval; a closed-but-unmerged PR NEVER auto-archives. (Gap B.)
- **I7 — UI is a projection:** the rendered lane/packet/tab set equals the set of non-terminal governed lanes, always; no cached status survives lane terminality. (Gap D; kills manual sweeps.)
- **I8 — Ready means ready:** a worker is never spawned against a backend that cannot serve its full contract (gated API on migrated DB + ws-server + operator MCP socket). (Fix-6 completion.)
- **I9 — Restart is clean:** an update/restart never leaves a port held by an orphan; the new instance always binds fresh ports and every consumer follows `~/.o8/api-port`. (Holds today — pin with the boot orphan-reap test.)
- **I10 — Sweeps scale:** per-tick sweeper cost is O(repos + live workers), never O(lanes). (Perf items below.)

---

## 5. Perf/scale review (500 lanes)

Shared owned-session index **did** remove the O(lanes×sessions) readdir hotspot — both former sites converted, freshness safe (see fix 8). Timer inventory and the next offenders:

| Timer | Interval | Cost @500 lanes |
|---|---|---|
| worktree reaper | 5 min | **~500 `git merge-base` subprocess spawns per tick — the #1 offender** |
| claude-code liveness (silent-exit + reaper) | 30s / 5 min | ps+lsof per claude-code lane per tick, unshared — **#2 offender** |
| silent-exit detector | 30s | in-mem scan + shared index (cheap); ~4 git procs per genuinely-dead lane |
| zombie reaper | 5 min | gated on >90s stale heartbeat; shared index (cheap) |
| ws stall-check / review-poll / heal-bot / dash-GC | 30s/10s/60s/30min | in-mem, fine |

**Coalescing plan:** (a) worktree-reaper.ts — group lanes by repoPath, ONE `git branch --merged <base>` per repo per tick building a merged-set; replace `branchIsMergedIntoBase` (L37-52) with a set lookup → O(repos). (b) claude-code.ts:889 — wrap `findLiveClaudeProcesses` in a ~2s TTL memo mirroring the owned-session-index pattern, so one ps+lsof snapshot serves every lane and both sweepers.

---

## 6. Ranked hardening backlog (packet-scoped)

Ordered by operator impact per cost. ✅ = safe to dispatch to a Codex worker as-is; 🔶 = needs design sign-off first.

| # | Packet | Anchors | Disp. |
|---|---|---|---|
| H1 | **Finish fix 2:** route MCP creator + targets/dispatch through `nextInlineIssueNumbers`; make the helper collision-proof (random suffix or DB sequence). Contract test: 1000 concurrent creations, zero collisions. | operator-handlers/mission.ts:829 · targets/dispatch/route.ts:54 · shared.ts:62 | ✅ |
| H2 | **Kill branch-slug assassination:** unique number IN the branch (`inline/${number}-${slug}`). Real-path test: two same-title missions coexist. | operator-mission-service/mission.ts:41-44 | ✅ |
| H3 | **Close the reset bypass:** `reset_packet --clearWorktree` scopes cleanup to the packet's own lane ids, never by branch. | reset.ts:85, :223 · branch-cleanup.ts | ✅ |
| H4 | **Gap B ship 1+2:** `lanes.prNumber` migration + stamp at pr_created; mirror-driven reconciler (mergedAt only) folded into the reaper tick. Real-path test: squash-merged PR → lane archived ≤ one interval; closed-unmerged → untouched. | schema.ts · lane/commands.ts:775 · worktree-reaper.ts · github-broker/sync.ts (refresh reviewing lanes' PRs — list is state=open only) | ✅ |
| H5 | **Gap C:** timer-driven wedged sweep per the taxonomy table (§2C), incl. the idle-vs-elapsed alarm fix (fix-7 residual). Thresholds are specced; salvage reuses forceCodexSelfReviewToReview. | self-review-stall-guard.ts · silent-exit-detector.ts:457 · ws-server.ts:604 · reaper.ts | ✅ (spec in §2C) |
| H6 | **Finish fix 6:** real readiness endpoint (DB migrated + ws-server up + operator MCP socket listening) consumed by dispatch-readiness. Keep it GET-only under /api/setup/*. | api/setup/status/route.ts (or new readiness route + middleware entry) · dispatch-readiness.ts | ✅ |
| H7 | **Gap A ship 1:** `lanes.missionId` migration + stamp at lane creation. Invisible; keystone for A and D. | schema.ts · lane creation path | ✅ |
| H8 | **Perf pair:** per-repo merged-set in worktree reaper; memoized claude-code process snapshot. | worktree-reaper.ts:37-52,86 · claude-code.ts:889 | ✅ |
| H9 | **Gap D:** derive packet live-status from lanes in /api/orchestrator/state (no cached status); structural reconciliation sweep + lane-lifecycle broadcast; retire per-instance tab-close listeners (subsumes the uncommitted useWorkspaceTerminal.ts:910 point-fix). | orchestrator/store.ts:774-900 · state route · ws-server.ts:4362 · AgentsTab/utils.ts:102 | 🔶 then ✅ |
| H10 | **Gap A ships 2–4:** mission registry + active set, dispatch tick loops, UI multi-mission, retire singleton + archiveMissionsExcept. HIGH blast (control-plane lock). | control-plane.ts · headless-loop.ts · mission.ts · state/route.ts | 🔶 design first |
| H11 | **Token W1:** codex compose tier at `model_reasoning_effort=low` for the sub-only plan class. | compose-class-a.ts:186,275 · codex-adapter.ts · local-model.ts | ✅ |
| H12 | **Token W2 (optional):** enforce brain-first as a first-turn cortex_ask mechanism in the codex backend, not a prompt nudge. | lane/orchestrator-backends/codex.ts | 🔶 product call |
| H13 | **Invariant tests:** pin I1–I10 as real-path contract tests (constructed Requests / persisted rows, per the reachability doctrine). Land alongside each packet above; I3 + I9 can pin immediately. | tests/ | ✅ |

**Suggested dispatch waves:** Wave 1 = H1+H2+H3 (kills the entire assassination class, all tiny). Wave 2 = H4+H6+H11 (stale-UI generator, readiness, cheap Brain). Wave 3 = H5+H7+H8. Wave 4 = H9, then H10 after design review.

---

## 7. What makes this Apple-grade

The pipeline's failure modes all reduce to four sentences: *work was buried* (fixed, pinned), *live lanes were assassinated* (Wave 1 closes the last vectors), *finished work never closed* (H4), and *the UI lied* (H9, structurally). With I1–I10 pinned as contract tests, a stranger dispatching ten packets gets ten lanes that each end in exactly one of: merged, archived-by-their-hand, or a clear operator card — nothing else is reachable. That's dispatch made boring.
