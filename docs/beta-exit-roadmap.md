# Beta-Exit Roadmap (executive audit 2026-07-08)

Synthesized from five parallel audits: product docs vs built, 6 weeks of git history (1,751 commits),
the open issue backlog (125 issues), an architect-level structural audit, and the vault readiness
scorecard (80/100, 2026-07-05). This doc is the tracking artifact for the work; the PR that
introduced it carries rocks 2 and 4.

## The read

Engineering (architecture + capability) grades ~90; the weak legs are **distribution & proof (52)**
and **first-stranger readiness (68)**. But the last 48 hours of dogfooding filed 25 issues in two
clusters that sit directly on the product's core promise — the loop is not yet trustworthy under
real use. Beta exit = five rocks (four engineering, one proof) + three explicit scope declarations.

## The five rocks

### Rock 1 — Dispatch/lane lifecycle contract (M-L) — BUILT (this PR)
- [x] Terminal-state contract unified — one source with two EXPLICIT notions: LANE_TERMINAL
      {failed,completed,archived} vs WORKER_TERMINAL (+reviewing); call sites import the
      explicit name. Wedge-timeouts in the reaper (recovering >15m → awaiting_orchestrator;
      awaiting_orchestrator >60m → awaiting_input + card; paused/awaiting_input >24h → reminder
      card), edge-triggered `wedge_timeout` events — nothing parks silently. TLA+ replay
      (~/o8-formal audit): new transitions CONFORM.
- [x] Cancel/kill (#1471): stop verb existed (#1286); now confirmed-kill
      SIGINT→SIGTERM→SIGKILL, status flips only on kill(pid,0)→ESRCH; a SIGKILL survivor parks
      as kill_unconfirmed with worktree intact; `kill_escalated` event per stage.
- [x] Idempotency persisted (#1497): SQLite `idempotency_keys` (schema v32), reserve→finalize —
      in-flight duplicates get "in progress, not re-executed", completed ones replay the stored
      result; wired at the shared route seam for steer/rerun/reset (+dispatch on explicit key);
      restart-durability real-path tested.
- [x] Restart sweep safety (#1500–#1502 class): reconcile already refused to archive live
      lanes; the sweep now also protects recent orphan clones via the prune gate.
- [x] Prune-safety: `prune-gate.ts` — every worktree/clone deletion refuses on uncommitted
      work, recent mtime (30m, bounded sample — never a recursive walk), or non-terminal lane;
      `prune_refused`/`prune_forced` events; the force path that ate two worktrees is gated.
- [x] Transcript/session binding (#1502): root cause corrected — dispatch DOES persist
      sessionKey uniformly; the zero-transcript symptom is a readback gap. Fault detector at
      heartbeat + progress routes: null binding → `no_session_binding` event + human_required
      inbox card (never self-closes).
- [x] Steer reachability (#1496): huddle zero-diff exits park steerable (session kept warm)
      instead of failing the packet.
- Follow-up: `awaiting_human` is referenced by UI/docs but absent from the persistable lane
  status enum — wedge escalation uses awaiting_input + card for now; adding the real enum value
  touches schema + status unions + UI switches, decide deliberately.
- Evidence: 18 issues (#1463–#1502) from one dogfood session, re-confirmed live 2026-07-08 by a
  second orchestrator (co-signed with receipts); orchestrator = only churn hotspot in 6 weeks of
  history (29 fixes). Salvage-ref banking is currently a coping strategy standing in for this
  contract. Dupes folded: #1499→#1486 (ship-over-existing-release, hit independently twice in
  24h), #1510→#1485 (flaky steering test).

**RE-AUDIT 2026-07-08 (code-level, clause by clause): DECOMPOSED — no longer one rock.**
Scaffolding largely exists: stop verb end-to-end (#1286: `orchestrator/stop-packet.ts`, routes,
CLI), restart reconcile refuses to archive live lanes (lost session→paused, missing
worktree→awaiting_orchestrator + card), reaper preserves worktree HEAD, cleanup checks
uncommitted work. Remaining core = ONE STONE (~2–3 days): a lane-lifecycle invariant module that
(a) unifies the two divergent terminal-state definitions (`lane/terminal-states.ts` vs
`lane/types.ts` disagree on `reviewing`) and adds wedge-timeouts for `awaiting_*`/paused/
recovering so nothing parks forever, and (b) routes every worktree-prune path through one guarded
gate (uncommitted OR recent-mtime → refuse + emit lane event; the force path currently has no
dirty check). Separable follow-ups, each PEBBLE–STONE: persisted idempotency key on steer/rerun
(#1497 — cache is in-memory and only guards merge verbs), confirmed-kill escalation
SIGINT→SIGTERM→SIGKILL (#1471 S1), headless transcript binding (#1502), huddle-exit steer
reclassification (#1496).

### Rock 2 — Telemetry + updater safety, one program (M-L) — THIS PR
- [x] Process-level crash capture (uncaughtException/unhandledRejection) in Next server + ws-server,
      persisted locally under `~/.o8/telemetry/` (ring-buffered)
- [x] Renderer error capture routed to the same store
- [x] Opt-in (default OFF) batched upload, ingest URL env-configured (`O8_TELEMETRY_INGEST_URL`);
      Settings toggle with plain-language "what's collected"
- [x] Updater kill-switch: release-health manifest checked before applying an update; a pulled
      version is skipped (fail-open on network errors)
- [x] Rollback path: operator can reinstall the previous signed release (`scripts/rollback-release.mjs`,
      minisign-verified; dry-run proven against v0.1.565)
- Follow-ups: in-app text field for the ingest URL; an ingest endpoint (license-server) before
  public launch; telemetry console UI (#1454).
- Evidence: zero crash reporting in the codebase; local `npm run ship` bypasses CI; no rollback,
  no staged rollout. A bad release currently hits the whole fleet invisibly and irrecoverably.
- Related: #1454 (opt-in fleet telemetry console — the console UI is follow-up, not this PR).

### Rock 3 — Symon Agent Mode desktop half (L) — LANDED, now a PEBBLE
Desktop half (phone-hosted realtime voice, Mac-executed tools) landed on main 2026-07-08
(8edbfe16). Code-level re-audit: COMPLETE, zero stubs — symon WS channel with full handler set +
stale/preemption sweeps, ephemeral mint with the contract's exact error table, strict
callId-correlated execution through the same SafetyClass gate as desk, symmetric last-start-wins,
and a real-path verifier (`scripts/verify-symon-agent-mode.ts`) that drives an actual ws-server
over a real WS client. Phone-side approval is excluded from v1 BY CONTRACT (confirm-gated tools
honestly return needs_confirmation; approval stays on the Mac dock).
Remaining (PEBBLE — one dogfood session, no code): real iPhone against the installed app with a
BYOK key — mint through the real webview bridge, one real tool round-trip, desk↔phone preemption
both directions within ~3s, confirm-gated tool pops the Mac dock card.

### Rock 4 — ws-server decomposition (L) — THIS PR
- [x] Event-loop lag watchdog with `[ws-health]` logging + counters on `/health` (caught real
      2.8s/6s boot spikes during verification)
- [x] Hot-path sync FS calls converted to async (startup-only sync probes documented inline)
- [x] PTY/terminal-host seam built + real-fork tested; ships OPT-IN (`O8_TERMINAL_HOST=child`,
      default `inline`) — flip the default only after a packaged-build dogfood
- [x] Helper clusters decomposed into `src/lib/ws-server/` (channels/backpressure moved
      byte-for-byte; LOSSY vs DURABLE semantics unchanged); entry stays the waived multiplexer
- Follow-ups: packaged dogfood of child mode, then default flip; deeper split of the singleton
  core if wedges recur despite the watchdog data.
- Evidence: #1498 (event loop wedged minutes on a sync FS walk; every mobile client shares that
  one thread). The specific walk was fixed; the structural exposure was not.

### Rock 5 — Native mobile app to the App Store (L) — DECOMPOSED
- [x] Parity audit vs web `/mobile` — the 07-07 handoff is FULLY RESOLVED (review-units authority
      e214e6c3, canonical fleet session identity 6a5fe067, agent-visible identity d78ba854)
- [ ] TestFlight (2 stones + pebble): first EAS production build with the full current native set
      (WebRTC + widgets + relay — wired but never cloud-built; quota blocked 06-27, reset 07-01,
      nobody re-ran); relay E2E green (in flight now); rename fork-residue package name "chat"
- [ ] App Store submission (stone + external rock): listing copy + full screenshot set + hosted
      privacy policy; then Apple review itself (camera/mic/local-network/background-audio +
      companion-app dependency = week+ of calendar, not engineering)
- [ ] Retire the parallel web surface (after TestFlight proves out)
- Evidence: `~/o8-mobile` near feature-parity native (chat/fleet/approvals/diffs/activity/
  terminal/symon-voice/pairing), 10 commits today on Relay v1. Desktop relay connector
  (`src/lib/mobile/relay-connector.ts`, db39127f) already wired into ws-server bootstrap;
  standalone private `o8-relay` Railway service + cross-repo E2E matrix in flight 2026-07-08.

## The proof gate (parallel, non-engineering)
- [ ] Fresh-machine walkdown: DMG → sign-in → badge → first merge on the clean Intel MacBook
- [ ] Five recorded golden-path demos (record AFTER rock 1 stabilizes)
- [ ] One real live purchase through the founder ladder
- [ ] First external operator session
- Fold #1013/#1014 (external-engineer / non-engineer readiness epics — oldest untouched) into
  this track.

## Scope declarations needed (in or out of beta-exit)
- **Team Governance tier** ($25/seat; schema-only today) — recommend post-beta, first post-beta rock
- **Windows/Linux port** (144 macOS cfg blocks; a port, not a flag) — recommend post-beta
- **Cloud sync / managed orchestrator runtime** (zero code) — recommend post-beta

## Sequence
Weeks 1–2: rock 1 with telemetry foundation (rock 2) in parallel. Weeks 2–5: rock 4 hardening,
rock 3 verification, rock 5 submission track. Proof gate opens as soon as rock 1 stabilizes.

Status update 2026-07-08 (post-cleanup): the canvas↔Symon cluster (#1503–#1510) is beaten — 5 of
7 resolved on 0.1.566 (#1503, #1507, #1509 fixed; two closed as dupes), #1508 kept open honestly
(landed fix is hygiene, live probe stays armed), epic #1505 in progress (1 of 7 items done). The
lifecycle cluster (#1463–#1502) is intact and is THE beta-exit rock.

## Merge-to-ship plan (2026-07-08 re-audit)

Rocks-to-pebbles scoreboard: rock 2 DONE (this PR) · rock 4 DONE (this PR) · rock 3 code-complete
(pebble: live dogfood) · rock 1 decomposed (one stone core + 4 small follow-ups) · rock 5
decomposed (TestFlight = 2 stones; Apple review = external calendar).

1. Relay E2E agent + mobile parity/connection agent finish and land on main.
2. Merge latest main into this PR — expect a real `src/ws-server.ts` merge (relay connector
   bootstrap wiring vs the rock-4 restructure); re-verify (tsc, targeted suites, :3999 boot).
3. Merge this PR to main; ship next version (Q-gated).
4. One post-ship dogfood session covers three pebbles: Symon agent mode live (iPhone), terminal
   host child mode in the packaged build (then flip the default), UI parity eyeball.
5. Next build effort: the rock-1 stone core (lifecycle invariant module + guarded prune gate),
   then the EAS TestFlight build stone.

## Redundancy audits (2026-07-08, two architect passes) + consolidation backlog

**Cleared as NOT redundant:** huddle vs Collide (orthogonal axes — worker alignment pre-edit vs
orchestrator-turn quality; they compose) · Collide vs Best-of-N (converge-auto vs diverge-human,
different cost class) · auto-review's blind second pass (nested escalation, not duplication) ·
retry_packet vs reset_packet (one implementation, honest worktree-wipe flag).

**Fixed in this PR (audit fold-ins, each traceable to a finding):** stuck-`launching` wedge rule
(the unowned failure shape); reconcile restart-lost sessions → `recovering` (one state model with
the reaper, riding the recovering wedge escalation); advisor-armed workers get the zero-diff park
safety net (they could silent-exit where huddle-armed workers were protected); single alignment
prompt block when both huddle and advisor arm (was double-injected).

**Consolidation backlog (separate designed efforts — threshold/behavior sensitive):**
1. Unify the two dead-lane archivers (reaper `archiveStaleDeadLanes` vs silent-exit
   `archiveTerminallyDeadLanes` — divergent status sets, 15m vs 30m thresholds; one policy table)
2. Merge silent-exit + reaper into one dead-owner triage tick — shared owned-session probe
   (~80 duplicated lines), shared salvage-commit routine (coded twice), one grace-window policy
3. Merge-verb idempotency onto the persisted store — needs a startup reservation-reaper so a
   restart-interrupted merge doesn't report in-progress until TTL (deliberate behavior change)
4. Wedged-but-alive liveness (heartbeat-stale, process looping) — no owner today outside codex
   stall-guard; needs a progress-delta design
5. Full huddle+advisor resolver unification (`resolvePacketAlignment()` — touches mission schema
   + prompt contract)
6. `awaiting_human` as a persistable lane status (schema + unions + UI switches)
