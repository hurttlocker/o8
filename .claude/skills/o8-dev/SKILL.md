---
name: o8-dev
description: How to develop o8 itself — the bootstrap doctrine (ginsu hardens o8 dispatch from OUTSIDE, then the fleet + shipping loop run THROUGH o8), the model ladder, the dispatch→review→ship loop, and the hard-won lifecycle traps. Load at the start of any o8 development session, before dispatching the fleet, or when deciding who does a task (me / ginsu / the o8 fleet).
---

# Developing o8 (the self-hosting bootstrap)

o8 is a fleet-orchestration product we build BY orchestrating a fleet. The catch: o8's own dispatch pipeline isn't fully hardened, and the meta-bugs that break dispatch can't be reliably fixed by the fleet — they're the thing that's broken. So there's a bootstrap.

## The bootstrap doctrine (Q, 2026-07-18)

**ginsu lives OUTSIDE o8 → it hardens o8's own dispatch until the fleet runs smoothly → THEN feature work and the shipping loop run THROUGH o8.** That's how we speed up shipping: dogfood the fleet on real work once it's reliable, and use ginsu (immune to o8's dispatch bugs) to get it reliable.

Division of labor:
- **ginsu (Codex sol xhigh, external, via `ginsu send datagate "…" --model gpt-5.6-sol --effort xhigh`):** o8-dispatch-HARDENING bugs, adversarial review of risky fixes, and any task the fleet can't dispatch smoothly YET (large packets that keep stalling). External = it won't be killed by the very bug it's fixing. Multi-issue BATCH tickets are fine and fast (it's strong) — group by shared file area to minimize conflicts. **CRITICAL: ginsu works in the MAIN tree and leaves changes UNCOMMITTED ("no commit"). COMMIT one batch before queuing the next, or the second batch's edits pile onto the first's in the shared working copy and you can't tell them apart. One batch → review → commit → next batch.** Also: don't double-background the send (`&` + run_in_background) — it detaches the log; use a single background mechanism so `/tmp/ginsu-*.log` captures the report.
- **Fable (orchestrator):** decisions, review of every diff, hardest synthesis, ship gate. Conserve usage — don't code inline when a worker can. Never spawn Fable subagents (sole Fable, low usage).
- **The o8 fleet (Codex sol xhigh via `create_mission`):** the packets it CAN complete smoothly today. Don't feed it the tasks that stall until the stalling bug is fixed.
- **Opus native agents:** fallback when ginsu is busy and the fleet can't take it.

Model ladder: **xhigh is the default effort. MAX effort = codex fans out / sub-delegates (its orchestrator mode) — extreme usage, use only when a task genuinely warrants.** Codex is effectively free (sub with resets — burn before they expire); prefer it heavily. Never `claude -p`.

## The dispatch → review → ship loop (through o8)

1. **Dispatch:** `create_mission({repoPath, issues:[…], runtime:'codex', existingBranchPolicy:'reset'})`. Constraints string MUST include: "commit with explicit pathspecs, NEVER `git add -A`" (the token-leak trap below) + tsc/test-green + the repo rules.
2. **Watch:** `wait_for_mission_ready({missionId, timeoutMs:1800000})` — long-poll that returns the instant a packet hits review/terminal; that return re-enters your turn (this is how you "get pinged" — o8 workers are NOT harness-tracked, so re-arm it or piggyback on a ginsu/background-task notification). Verify liveness via `get_mission_status` + the owned rollout tails; the UI packet card via `o8_view_*`.
3. **Review EVERY diff:** `o8_packet_diff` + `o8_review_state`. The o8 auto-reviewer runs too — read its verdict. Apply the review discipline below.
4. **Merge or salvage:**
   - Clean + gate passing → `approve_and_merge`.
   - Gate blocked on a credential/artifact leak but the CODE is verified correct → **salvage by pathspec**: copy the specific good files from the packet worktree into main, verify no `.tmp-owned-push-*`, tsc+test, commit with explicit pathspec. (Never merge a branch carrying a leaked token.)
   - Rejected on real findings → `steer_packet` (warm, cheap) or `rerun_with_feedback` (fresh).

## Review discipline (non-negotiable)

- **Anti-duplication (Q ruling):** before fixing, recon what already exists; adjudicate every delegated diff against existing machinery — if a worker rebuilt something, compare old vs new, keep the BETTER one, delete the loser. Brief workers to REUSE named existing pieces. (Proof: #1537 was 35 lines wiring dormant mac_perms machinery, not new FFI.)
- **Reachability / fail-on-old-code:** a new seam needs a test through the REAL entry point that FAILS on the pre-fix code. Prove it: strip the guard, run the test, confirm it fails, restore. A green test that also passes on old code proves nothing (the "encodes the premise" trap).
- **Trust the governance gate:** the auto-reviewer catching a leaked worker token / a rule violation IS the product working — surface it as a win, fix the source.

## Lifecycle traps (all hit + fixed the night of 2026-07-18; keep the doctrine)

- **Activity IS liveness, unknown KEEPS.** Every lane/worktree lifecycle guard (zombie reaper, worktree pruner, self-review-stall) must treat fresh transcript activity (owned-session `runs/*.jsonl` mtime — `reaper-liveness.ts ownedTranscriptMtimeMs`) or a live process as alive, and FAIL CLOSED on any uncertainty (probe error / unresolvable = keep, never reap). Heartbeats are worker-VOLITIONAL (`o8 packet heartbeat` CLI only — no server pulse), so a long turn freezes them while alive; never reap on heartbeat staleness alone.
- **npm-test-in-a-worktree kills the real fleet (#1585 class).** Vitest imports owned-session modules, which default their root to the REAL `~/.o8/owned-<runtime>`; the import-time orphan sweep then SIGINTs live production workers. `tests/setup-isolated-data-dir.ts` MUST redirect ALL owned-root env vars (CORTEX_IDE_OWNED_CODEX_ROOT, …_CLAUDE_CODE_ROOT, O8_OWNED_{GEMINI,OPENCODE,CURSOR,GROK,PI}_ROOT) to temp, AND markActiveRunOrphaned must never signal a foreign PID when `O8_TEST_DATA_DIR_PINNED` is set.
- **Ship-wedge: worktrees drown `next build`.** `.cortex-worktrees` clones live inside the repo, so `next build` file-traces them → OOM (exit 134). Keep worktree retention ON (`worktreeMaxCount`/`Gb` = 20); if it OOMs, quit o8.app (releases the backend's file-watch handles), `git worktree remove --force` all + prune + `rm -rf .next/cache`, then re-ship. Better fix (queued): relocate the worktree root to `~/.o8/worktrees` — OUT of the repo tree (no drown), same APFS volume (CoW clones stay cheap). NOT an external drive (CoW breaks cross-volume; never T7 — read-only camera masters).
- **`.tmp-owned-push-*` token leak → never `git add -A`.** o8's owned-push tmp artifact holds a live worker token; a bare add sweeps it into the commit and the gate rejects the merge. It's gitignored now, but worker briefs must still say explicit-pathspec-only.
- **Backend file-watches fool `lsof +D`.** The next-server backend holds handles across every worktree, so a live-process guard sees them all as "live" and won't prune while the app runs — distinguish backend watches from real worker cwd (open follow-up).
- **Green tests + green tsc ≠ green build (the server-only client leak).** `npm test` stubs `server-only` (tests/stubs/server-only.ts) and tsc doesn't run webpack, so a CLIENT component that imports a module which transitively pulls `import 'server-only'` (e.g. via the lane/orchestrator backends → codex.ts → haiku-adapter.ts) passes tsc + vitest but FAILS `next build` ("server-only ... not supported in the pages/ directory"). Fix: split the client-safe vocabulary (types/consts/pure fns) into a `*-shared.ts` with zero runtime imports; the client imports `-shared`, the server module re-exports it. Merges that add a client component reaching into a server module are the risk. **The ship runs `next build` and catches this — so a merge that's tsc/test-green can still break the ship.** Before shipping a batch that touched client↔server import boundaries, run `npm run build` yourself; don't trust tsc+vitest alone. (#1570 broke the .624 build exactly this way.)

## Disk hygiene (the internal disk fills and breaks ships)
The Mac's internal disk repeatedly hits <10GB and OOMs/ENOSPCs the ship. Before shipping, `df -h /`; if tight, reclaim in this order (all read-safe): dead `.cortex-worktrees/*` (biggest recurring hog — clear when 0 live workers), `~/o8/.next/cache` + `src-tauri/target/debug` (NEVER `target/release` pre-ship — it's the artifact), regenerable caches (`~/.npm/_cacache`, `~/Library/Caches/{codex,ms-playwright,go-build,CocoaPods,swiftpm}`, `~/.cache/codex-runtimes`), and DONE sibling feature-repo clones (verify `git branch -r --contains HEAD` shows the tip is on a remote before `rm -rf` a whole repo — else the work is lost). iOS simulators (12G) + Xcode (5G) are needed for the o8-mobile Expo lane — don't nuke while mobile is active. T7 (`/Volumes/T7 Touch/`) is archive-only under `rainwater/`, never a worktree target (read-only masters + CoW breaks cross-volume). A read-only Opus disk-audit agent is the way to get a classified reclaim map before deleting.

## Dogfood-first

Every dispatch is also a test of o8's dispatch itself. File EVERY friction as a GitHub issue with forensics (lane_events, rollout tails, log lines) the moment you hit it — that's how the blocker queue gets built. Dispatch fails → STOP and fix o8 (via ginsu), never reset+redispatch in a loop.

## The blocker queue lives in memory

`o8_dispatch_hardening_via_ginsu.md` holds the current ordered dispatch-smoothness blocker list. Read it; keep it current as ginsu clears items. When it's empty, the fleet + shipping loop run through o8 unaided — that's the goal.

Ship discipline itself: the `ship` skill.
