# Why merges are never smooth — root-cause diagnosis (2026-07-06)

Diagnosed natively by the orchestrator after the 10-packet backlog burn, where every failure mode fired in one night. **Verdict up front: the workers were fine — 9 of 10 packets were merge-quality on first or second pass. Every rough edge came from the platform's own merge/lane state machinery.** Five root causes, each with the file:line evidence and the fix. This is the "merge smoothness" program; #1457 is the tracking issue.

## RC1 — `releaseState` vocabulary collision → phantom "Already released"

**Evidence:** `src/lib/orchestrator/operator-mission-service/mission.ts:486` — the mission-state reconstruction path stamps `releaseState: lane ? 'released' : 'pending'`. Here "released" means *released from the dispatch queue into a lane*. But `merge.ts:116` (`isAlreadyReleasedPacket`) reads the same field as *merge released* and short-circuits `approve_and_merge` with `{merged: true, note: "Already released (via auto-merge)"}` — for a merge that never ran.

**Impact:** any packet whose mission state passes through reconstruction reports success on merge calls while main never moves. The orchestrator believes the work landed; it didn't. (Both #1441 and #1407 hit this on 2026-07-06; landed manually after ancestry checks.)

**Fix:** the reconstruction line must not write the merge-release field — `queueState: 'released'` on the line above already carries the queue semantics. `releaseState` may only be set by the merge path itself, carrying the merge SHA. Add a regression test: reconstruct a mission from packetMeta + live lane, call approve_and_merge, assert it does NOT short-circuit.

## RC2 — release claims are never verified against git ground truth

**Evidence:** `merge.ts` `buildAlreadyReleasedResult()` carries no SHA; nothing anywhere checks `git merge-base --is-ancestor <mergeSha> main` before claiming released. The inverse also fired: `approve_and_merge` returned `merged:false` with blockers for a merge that had already fast-forwarded (the checks ran on a stale snapshot after the ff landed).

**Fix (structural rule):** *release state must be derived from, or verified against, commit ancestry — never bookkeeping alone.* `alreadyReleased` responses must include the merge SHA and verify ancestry at answer time; a released-flag without ancestry = corrupt state → self-repair (clear flag, proceed with merge). Merge results must re-read HEAD after the merge attempt, not report the pre-merge plan.

## RC3 — silent-exit detector resurrects merged lanes (the "stuck UI")

**Evidence:** `src/lib/supervisor/silent-exit-detector.ts:376,414` — any dead-session lane whose worktree has commits ahead of base is promoted to `reviewing` ("silent_exit_work_present"). Two gaps: (a) it never checks whether that work is **already merged into main**; (b) "commits ahead" is computed against the packet CLONE's local base branch, frozen at clone time. A merged lane whose clone still exists reads as "unsalvaged work" forever — so the detector re-flips it to `reviewing` even after a manual DB repair. This is why the UI showed orange dots and a merge badge that would not die, and why direct DB repairs only stick when the app is down.

**Fix:** before promoting to `reviewing`, fetch origin/base (bounded, memoized — reuse `resolvePacketDiffBase` from #1441) and check `git merge-base --is-ancestor HEAD origin/<base>`; if ancestor → set lane `released` + schedule worktree cleanup instead. This one change kills the whole zombie-lane class.

## RC4 — the merge gate diffs against the clone's frozen main

**Evidence:** `src/lib/lane/merge-gate.ts:132,167,197` — security-patterns, diff-budget, and changed-files all run `git diff <baseBranch>...HEAD` inside the packet clone, where `<baseBranch>` is the clone's local main from clone time. Every packet merged to real main after the clone was created shows up as "this packet's new code": on 2026-07-06 the gate blamed #1197's gating.ts and #1065's `process.exit` on two unrelated later packets, demanding approvals for code that was already on main.

**Fix:** merge-gate.ts adopts `resolvePacketDiffBase` (shipped for the diff route in #1441 — same disease, same cure): fetch origin/base with the 60s memo, diff against the true merge-base. False blockers disappear; the approval cards that remain become meaningful again.

## RC5 — post-review rebase invalidates the review pin (`head_moved_since_review`)

**Evidence:** the auto-merge path rebases the packet branch onto main tip AFTER the review pin is recorded, changing HEAD → the next merge call rejects with `head_moved_since_review` → the reviewer must re-pin a SHA whose *content* is identical (verified twice tonight by per-commit stat equality). Reviews pin SHAs; rebases preserve content but not SHAs.

**Fix:** compare `git patch-id --stable` of the reviewed commit vs the current HEAD commit. Identical patch-id ⇒ same content ⇒ carry the review pin forward automatically (record `reviewCarriedAcrossRebase` in lane events for audit). Only genuinely new content forces re-review.

## Contributing factors (not root causes)

- **Stale `~/.o8/.dogfood-pr-only` sentinel** sat for a month (kill switch failed to remove it), forcing pr_only into every lane at creation; removing it mid-mission split bookkeeping from behavior. Fix: sentinel gets a TTL/ownership stamp + the kill switch verifies removal; mergeMode re-evaluates at merge time (in #1457).
- **MCP client timeouts on long verbs** (steer/rerun/approve ~>90s): the action fires but the caller sees a timeout → double-fires. Merge already has idempotency keys; steer/rerun need fast-ack + poll semantics.
- **Workers can't run `next build`** — the one genuine worker escape of the night (a `server-only` import reachable from the client bundle passed tsc + vitest, failed the ship build). Mitigation: packet briefs touching client-reachable `src/lib`/`src/components` must include `next build` (or a scoped client-graph check) in their gates; candidate for a merge-gate check.

## What this means for users

Every one of these produces the same felt experience: *"the merge wasn't smooth"* — phantom successes, false blockers, re-review loops, and badges that never clear. None are worker quality. RC1+RC2 are small, high-leverage patches (a one-line semantic fix plus ancestry verification); RC3+RC4 reuse machinery that already shipped (#1441's base resolver); RC5 is a patch-id comparison. All five are Codex-dispatchable with tight briefs; RC1/RC2 should merge first since they make every later merge's reporting trustworthy again.
