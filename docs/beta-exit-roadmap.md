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

### Rock 1 — Dispatch/lane lifecycle contract (M-L) — BLOCKS EVERYTHING
- [ ] Defined terminal-state contract for the packet/lane state machine (no silent wedges)
- [ ] Real cancel/kill verb, reachable from every surface
- [ ] Idempotency persisted across restarts (rerun/steer double-fire class, #1497)
- [ ] Restart sweep must never archive running packets (#1500–#1502 class)
- Evidence: 18 issues (#1463–#1502) from one dogfood session; orchestrator = only churn hotspot
  in 6 weeks of history (29 fixes).

### Rock 2 — Telemetry + updater safety, one program (M-L) — THIS PR
- [ ] Process-level crash capture (uncaughtException/unhandledRejection) in Next server + ws-server,
      persisted locally under `~/.o8/telemetry/` (ring-buffered)
- [ ] Renderer error capture routed to the same store
- [ ] Opt-in (default OFF) batched upload, ingest URL env-configured (`O8_TELEMETRY_INGEST_URL`);
      Settings toggle with plain-language "what's collected"
- [ ] Updater kill-switch: release-health manifest checked before applying an update; a pulled
      version is skipped (fail-open on network errors)
- [ ] Rollback path: operator can reinstall the previous signed release
- Evidence: zero crash reporting in the codebase; local `npm run ship` bypasses CI; no rollback,
  no staged rollout. A bad release currently hits the whole fleet invisibly and irrecoverably.
- Related: #1454 (opt-in fleet telemetry console — the console UI is follow-up, not this PR).

### Rock 3 — Symon Agent Mode desktop half (L) — LANDED 0.1.565/566
Desktop half (phone-hosted realtime voice, Mac-executed tools) landed on main 2026-07-08
(8edbfe16) after the audit snapshot. Remaining: live verification + governance review of the
phone-initiated tool-call approval path.

### Rock 4 — ws-server decomposition (L) — THIS PR
- [ ] Event-loop lag watchdog with `[ws-health]` logging + health surface
- [ ] Eliminate the 41 sync FS calls from the WS event loop's hot paths
- [ ] PTY/terminal handling isolated off the main WS event loop (child-process terminal host)
- [ ] Decompose the 6,307-line `ws-server.ts` into modules without changing channel semantics
      (LOSSY vs DURABLE preserved)
- Evidence: #1498 (event loop wedged minutes on a sync FS walk; every mobile client shares that
  one thread). The specific walk was fixed; the structural exposure was not.

### Rock 5 — Native mobile app to the App Store (L)
- [ ] Parity audit vs web `/mobile`
- [ ] Native-module EAS builds green
- [ ] App Store submission
- [ ] Retire the parallel web surface
- Evidence: full Expo SDK 55 app exists at `~/o8-mobile` (daily commits, EAS configured) — #1074
  reads "not started" but is stale. Phase-4 gate (resolve a real approval from the phone) is the
  stated pre-launch bar.

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
Weeks 1–2: rock 1 + canvas↔Symon wiring burst (#1503–#1510) with telemetry foundation (rock 2)
in parallel. Weeks 2–5: rock 4 hardening, rock 3 verification, rock 5 submission track. Proof gate
opens as soon as rock 1 stabilizes.
