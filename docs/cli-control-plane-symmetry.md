# CLI-as-Control-Plane Symmetry — Plan

*Orca teardown item #2 ("moat-compounding"). Refit through o8's lens — borrow the polish, never concede the moat.*

## The principle

**One `o8` binary serves both audiences over one surface:** the human operator (headless, no MCP client) and the agents (self-orchestration from inside a packet worktree). Skills are docs that teach agents which verbs exist. Today o8 has a rich agent-side CLI *and* an MCP operator server — but the **orchestration verbs live only in MCP**. An agent can run its own work but can't orchestrate; a human without an MCP client can't drive a mission from the terminal. Closing that gap deepens the agent-control story and makes every future control-plane capability reachable from one place.

## What we found (the substrate already exists)

The real orchestration logic is a clean service layer — `src/lib/orchestrator/operator-mission-service/` (`createMission`, `dispatchMission`, `getMissionStatus`, `submitPacketReview`, `approveAndMergePacket`, `resetPacket`, `rerunWithFeedback`). It **runs in the Next.js process** because it mutates the live in-memory orchestrator store + lane registry. Out-of-process callers reach it through the gated `/api/orchestrator/*` routes, which are thin wrappers (`requirePanelAuth` → parse → call the service).

- **The MCP operator server is already an HTTP client of those routes** (`src/lib/mcp/operator-mission-tools.ts` — its own bearer+retry `apiRequest`).
- **The CLI is already an HTTP client of the same routes** (`cli/src/api.ts` `apiFetch`, port/token via `cli/src/config.ts`). It already covers `status`, `ask` (↔ `cortex_ask`), `spec *` (↔ `o8_spec_*`), `task *` (↔ `o8_task_*`), and — proof the pattern works — **`o8 packet review --approve` already chains `/api/orchestrator/review` then `/api/orchestrator/merge`.**

So symmetry is **"add CLI commands that fetch existing routes"** — the clean path. No service rewrite.

### The exact gap (MCP-only, no CLI today)

| Group | Verbs | Existing gated route? |
|---|---|---|
| **Mission lifecycle** | create_mission, dispatch_mission, get_mission_status, wait_for_mission_ready, mission_tail | ✅ create-mission, dispatch, status (wait/tail = poll loops) |
| **Packet recovery** | reset_packet, retry_packet, rerun_with_feedback, merge_preview | ✅ reset-packet, rerun-with-feedback, merge-preview |
| **Steer** | steer_packet | ❌ **no route** — in-process `findLaneByPacket`+`setLaneStatus`+`/api/runtime/action` in the MCP handler |
| **Governance inbox** | o8_send, o8_approve, o8_reject, o8_history | ✅ delegate, /api/panel/approvals, transcript |
| **Repo/project lifecycle** | register_repo, init_repo, create_project, scaffold, render, operator_defaults | ✅ (panel/orchestrator routes) — lower priority |
| **Webview / canvas** | o8_view_*, o8_canvas | Unix-socket bridge — **out of scope** (not a control-plane verb) |

### Two structural cleanups the effort forces (correctness, not just symmetry)

1. **Extract a `steer_packet` route.** It's the only mission verb with no HTTP equivalent — the MCP handler mutates the lane registry in its *own* process (a separate in-memory instance from the app; DB-backed reads are fine but memory-resident state is fragile). Extract the logic into the service layer + a thin `/api/orchestrator/steer-packet` route, then point **both** the MCP handler and the new CLI command at it. Removes a real fragility.
2. **Move `approve_and_merge`'s idempotency + synchronous worktree-cleanup server-side.** Today they wrap the call *in the MCP process* (`operator-handlers/approve.ts`), so the idempotency cache is MCP-process-local — a CLI or mobile caller wouldn't get it. Move both into the merge route/service so **every** client (MCP, CLI, future mobile) inherits the same safety. Repoint `o8_merge_preview` onto its route too.

## Governance — the moat guard (the one decision)

The approval surface + audit ledger is our moat. CLI symmetry must expose the verbs **without letting a worker self-approve its own merge to `main`.** Capability is symmetric; *authority* stays governed.

Proposed policy (the verbs split into two tiers):

- **Open to any caller (human or agent):** mission read + telemetry (status, wait, tail, ask, spec, observe, report), mission **create/dispatch** (sub-orchestration — already the Claude-orchestrates-Codex pattern), and recovery of one's **own** sub-work (reset, retry, rerun, steer, merge-preview). These are how an agent legitimately self-orchestrates.
- **Operator-authority only (governed):** `approve_and_merge` to `main`. A **worker-context** call does **not** auto-execute — it raises an approval card for the operator (or is blocked), preserving the review-inversion. A **human headless operator** call executes.

How we tell worker from operator: not by auth (the loopback bearer token is shared). By **context** — dispatched workers get an `O8_WORKER_PACKET_ID` (or reuse the cwd→packet resolution) stamped at dispatch; the merge route reads it and applies the policy. This is the single new server-side check the moat requires.

> **DECISION (locked 2026-06-27, Option 1 — "the moat as a verb, not a wall"): a worker-context `approve-merge` raises an operator approval card; it does NOT auto-merge to `main`, and it is NOT an error.** Gate on **context, not the verb** — same `approve-merge` for everyone, behavior differs by caller:
> - **Worker (agent in a packet worktree):** does not merge. Pushes the merge-preview/diff onto an approval card in the Stage-6 inbox and **returns immediately** with a clean `submitted — pending operator approval` status (a legit outcome, not a dead-end error). The agent drives the entire loop; the one thing it can never do is silently merge its own work to `main`. It does not block waiting.
> - **Operator (human, headless):** merges directly, as today.
> - **The merge itself**, once the operator approves the card, runs through the server-side idempotent `approve_and_merge` (Stage-5 normalization) so every client inherits the same safety.
>
> Why not hard-block: an error is a dead-end and surfaces by accident — worse coordination, not better. The card keeps full capability symmetry while preserving the review-inversion, which is the moat. **Zero net-new infra** — it wires straight into the Stage-6 inbox approve/reject queue.

## Command namespace

- `o8 mission create | dispatch | status | wait | tail` — mission lifecycle
- `o8 packet reset | retry | rerun | steer | merge-preview | approve-merge` — packet-level verbs (joins the existing `packet info/scope/diff/commit/heartbeat/review/report/log` group)
- `o8 inbox list | approve | reject | send | history` — governance inbox (`o8 status` already *reads* pending approvals; `inbox` adds the mutations)

Every command is a thin `apiFetch` to an existing route via the shared `cli/src/api.ts` client + the hand-rolled two-level switch dispatcher in `cli/src/index.ts` (add an import + a `case` + a USAGE line + a `commands/<group>.ts`). Output stays the `schema: 'o8/cli/<cmd>/v1'` JSON contract via `printJson`.

## Status (2026-06-27): stages 1–8 SHIPPED + verified live (0.1.511)

All eight stages are code-complete, committed, and `tests/control-plane-parity.test.ts` asserts every verb's shared backing route exists (11 cases green). **End-to-end live verification passed on 0.1.511**, driven entirely through the new CLI:

- `o8 mission create` → `o8 mission dispatch` launched a real Codex worker (single packet, `fan=0`, own worktree).
- Worker reached `reviewing` (`review_ready`) at **t+101s** — the lint-stall fix holds (no multi-minute repo-wide-lint stall; wrote only the one intended file).
- Worker-context `o8 packet approve-merge` (run from the worktree) returned `merged:false, status:'pending_operator_approval'` and raised an approval card with the diff attached — **it did not merge**.
- `o8 inbox list` surfaced the card; `o8 inbox approve <id>` dispatched the held merge through the gate, which PR-only mode correctly blocked ("open a PR; a human merges"). `main` unchanged throughout.

The moat held as a verb: the agent drove the entire loop, the one thing it could not do was silently merge its own work to `main`.

## Staged plan (each stage: tsc-clean + lint-clean + committable + a test)

**Stage 1 — Lock decisions.** Namespace (above) + the governance tier (the DECISION, locked Option 1). No code. ✅ DONE.

**Stage 2 — Mission lifecycle.** `o8 mission create | dispatch | status | wait | tail`. Thin route calls; `wait` mirrors `wait_for_mission_ready`'s terminal/signature-change semantics, `tail` prints packet status transitions until terminal. ✅ DONE (commit c0e0e159) — verified live: create → status-by-id round-trips; tsc + cli typecheck clean.

**Stage 3 — Packet recovery.** `o8 packet reset | retry | rerun | merge-preview`. Pure route calls. Test: each verb's route has explicit default-deny middleware coverage (`tests/middleware-gate.test.ts` + `tests/route-coverage.test.ts`); CLI smoke for reset+retry on a stuck packet.

**Stage 4 — Steer extraction.** New `/api/orchestrator/steer-packet` route + service fn; repoint the MCP `steer_packet` handler at it (delete the in-process tangle); add `o8 packet steer`. Test: gate test for the new route + a unit test for the service fn; confirm MCP still steers.

**Stage 5 — Merge-seam normalization.** Move idempotency + synchronous worktree-cleanup into the merge route/service; repoint MCP `approve_and_merge` + `o8_merge_preview` onto routes; add `o8 packet approve-merge` honoring the locked governance tier. Test: idempotent double-merge returns the cached result regardless of caller (MCP vs CLI); worker-context merge raises a card (per decision).

**Stage 6 — Governance inbox.** `o8 inbox list | approve | reject | send | history`. Thin calls to `/api/panel/approvals` + `/api/orchestrator/delegate` + transcript. **Worker-context `approve-merge` lands its card here** (the Stage-5 wiring resolves into this queue). Test: gate cases + CLI approve/reject round-trip + worker-context merge → card appears → operator approve → merges.

**Stage 7 — Skills are docs.** Teach agents the new verbs: extend `AGENTS.md` (the agent CLI section) + a focused `docs/agent-cli-control-plane.md` skill doc + the orchestrator instructions (`src/lib/lane/orchestrator.md`) so an agent self-orchestrates by shelling `o8 mission …` instead of re-deriving. Update CLAUDE.md's agent-CLI pointer. (Spec-ingested → also reaches the Brain.)

**Stage 8 — Parity audit + sweep.** A parity table/test asserting every control-plane verb has BOTH an MCP tool AND a CLI command backed by the SAME route. Remove now-superseded MCP in-process shortcuts. Full `tsc` + `npm test` + an end-to-end CLI mission smoke on a fresh DB. Update `docs/vocabulary.md` if any label diverges.

## Acceptance

- Every orchestration verb is reachable from `o8 <verb>` **and** the MCP tool, both hitting the same gated route — proven by a parity test, not by inspection.
- An agent in a worktree can `o8 mission dispatch` a sub-packet and `o8 packet steer`/`reset` its own work; a worker-context `o8 packet approve-merge` does **not** silently merge to `main` (raises a card / blocks per Stage 0).
- A human headless operator can drive a full mission (create → dispatch → status → review → approve-merge) from the terminal with no MCP client.
- No service-layer rewrite; the only new server code is the `steer-packet` route + the merge-seam move + the worker-context policy check.

---

*Source maps: the o8 CLI inventory (`cli/src/{index,api,config}.ts` + `cli/src/commands/`) and the MCP/service map (`src/lib/orchestrator/operator-mission-service/`, `src/lib/mcp/operator-mission-tools.ts`, `src/lib/mcp/operator-handlers/`, `src/app/api/orchestrator/`). The shared core already exists — this is a symmetry + governance pass, not a rebuild.*
