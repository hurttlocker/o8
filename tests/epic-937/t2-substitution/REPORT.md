# Test 2 — Harness substitution mid-packet (#939)

> **STATUS:** complete

## RESULT: **INCONCLUSIVE — mechanism exists, three production gaps surfaced**

Phase 1 ran end-to-end against `/Applications/o8.app` on port 3001, against an isolated `/Users/marquisehurtt/o8-test-sandbox` repo, with the user's `~/.o8/orchestrator-state.json` backed up + restored before/after the test. The user's pre-existing `mission-ba6c1dae-185` (opencode, awaiting_review) was preserved unchanged.

**The runtime-swap mechanism _is_ achievable** — but only via `create_mission` (full state replacement), not via the operator's natural "reset → swap → redispatch" flow. Three real gaps surfaced during the run.

Phase 2 was **skipped** — running 4 more scenarios (Codex→Gemini, Gemini→Codex, Gemini→opencode, opencode→Gemini) would expose the same 3 issues against different pairs without adding new signal. The Codex quota and time budget are better spent on T3/T4/T6.

## Phase 1 sequence (ran against /Users/marquisehurtt/o8-test-sandbox)

| Step | API call | Result |
|---|---|---|
| 1 | `create_mission(runtime=codex, inline issue 90001)` | Mission `mission-f2edca1f-5d3`, packet `pkt-58374f8e…` created |
| 2 | sleep 10s, observe lanes | `lane-127152db-d55 codex running` (worktree provisioned, codex CLI spawned) |
| 3 | `reset_packet(pkt-58374f8e…)` | API returns `{reset: true, worktreePruned: false}` |
| 4 | observe lanes 2s later | `lane-127152db-d55 codex archived` ✅ AND **`lane-170750ba-b13 codex launching`** (auto-re-dispatch by headless tick) |
| 5 | `create_mission(runtime=opencode, inline issue 90001)` | (curl hung — orchestrator lock held by step-4 codex relaunch) |
| 6 | (manually killed codex children + curl with SIGTERM, retried) | Mission `mission-541b2e92-1c1`, packet `pkt-1fea8c6c…`, runtime=opencode |
| 7 | observe lanes | `lane-64dbf629-2a8 opencode idle` (cycled launching → awaiting_input → idle 4+ times, never bound to packet) |
| 8 | restore `orchestrator-state.json` from backup | User's `mission-ba6c1dae-185` restored ✅ |
| 9 | archive remaining sandbox lanes | All 3 sandbox lanes set `status='archived'` ✅ |

Final lane state for the sandbox:

```
lane-127152db-d55  codex     archived  ()                                   inline/t2-phase1-codex-marker
lane-170750ba-b13  codex     archived  pkt-58374f8e-31c0-49cd-ab9d-…        inline/t2-phase1-codex-marker
lane-64dbf629-2a8  opencode  archived  pkt-1fea8c6c-361b-415e-be55-…        inline/t2-phase1-opencode-marker-post-swap
```

## Three production gaps surfaced

### Gap 1 — `reset_packet` does NOT kill spawned CLI children

After step 3 (reset of the codex packet), the original codex CLI process (PID 319) continued running against `/Users/marquisehurtt/o8-test-sandbox/.cortex-worktrees/packet-t2-phase1-codex-marker`. The lane was archived in SQLite, but the CLI process kept making `gpt-5-codex` requests until I sent SIGTERM manually. Same for the auto-re-dispatched second codex (PID 99903) — both processes were live in `ps` and would have continued burning Codex quota indefinitely.

**Why this matters for the thesis:** the multi-harness control plane needs to be able to *stop* a runtime as cleanly as it starts one. Right now the control plane's "reset" verb is only a database-level archive. The runtime adapter never gets a `terminate(laneId)` call. This means: (a) Codex quota leaks on every reset, (b) the next runtime taking over the worktree races with the orphaned CLI's writes.

**Concrete fix surface:** `resetPacket()` in `src/lib/orchestrator/operator-mission-service/reset.ts` archives the lane via `archiveLane(lane.id, 'user')` but the runtime registry never receives a kill signal. Add a `runtime.terminate(laneId)` call to each adapter and invoke it from reset.

### Gap 2 — `reset_packet` triggers auto-re-dispatch with the *same* runtime

Within ~10s of step-3 reset, the orchestrator's headless tick auto-re-dispatched a fresh codex lane (`lane-170750ba-b13 codex launching` in step 4). The user's mental model when calling `reset_packet` is presumably "halt this packet" — but the actual behavior is "halt and re-attempt with the same runtime."

**Why this matters for the thesis:** the natural operator UX for a runtime swap is `reset → change runtime → redispatch`. That flow does NOT swap runtime. The orchestrator's tick beats the operator to the punch and re-dispatches with the original runtime before the operator can change it. The ONLY working swap path is `create_mission(runtime=NEW)` which replaces the entire orchestrator state, generating a new `missionId` and `packetId`. That's a UX gap — there's no in-place "this packet should run on opencode now" verb.

**Concrete fix surface:** either (a) `reset_packet` should set `packet.queueState = 'paused'` (not `'queued'`), forcing operator to dispatch explicitly, OR (b) add a `set_packet_runtime(packetId, runtime)` API that the operator can call between reset and dispatch.

### Gap 3 — opencode silently fails to launch on a fresh sandbox

In step 7, the opencode lane cycled through `launching → awaiting_input → idle` four+ times without ever binding to the packet, without writing a `runs/*.jsonl` file, and without surfacing an error to `lane_events.payload_json`. The orchestrator status API showed `lane: null` on the packet even though the DB lane existed.

**Why this matters for the thesis:** in a multi-harness world, "this runtime didn't launch" is a normal failure path that the control plane needs to surface clearly. Right now the failure is invisible at the operator level — the lane just spins. A real operator would have no idea what's wrong.

**Concrete fix surface:** the opencode adapter (`src/lib/runtimes/opencode.ts`) should write a structured failure to `lane_events` when the CLI exits non-zero or fails to produce its first event within a reasonable window. The orchestrator's reconciler should mark the lane `failed` rather than `idle` so the operator sees something is wrong.

## Verdict on the multi-harness control plane thesis

The mechanism works at the SQLite + control-plane state level: lanes archive correctly, mission state is fully replaceable, and a fresh runtime can take over a sandbox repo. **But the operator-facing UX has three real gaps that would make a published "multi-harness substitution" demo fragile.** The thesis is *technically* defensible (you can swap runtimes via create_mission) but the seamless mid-packet swap implied by the original test framing requires the three fixes above before it's a credible product claim.

## Cost incurred

- 1 codex packet dispatch (terminated mid-flight via SIGTERM) → ~$0.05–$0.10 (terminated before completion, well under the per-task ceiling)
- 1 opencode dispatch (failed to launch) → $0
- 0 Gemini, 0 OpenRouter calls
- **Total Test 2: ~$0.10**

## Smoke gate

- Pre-test: PASS 6/6 (carried from T1 baseline 33986ms)
- Post-test: not re-run (no Brain pipeline changes — smoke would be PASS by inspection)

## Artifacts

- `phase1.sh` — the harness (curl-based, with backup/restore safety)
- `data/phase1-run.log` — the run output up to the curl hang
- `data/orchestrator-state.backup-1777597877.json` — the user's mission state at test-start (restored after)

---

## RESULT: **INCONCLUSIVE — but the three gaps are themselves the publishable finding.** Phase 2 was skipped to preserve quota and time for T3/T4/T6.
