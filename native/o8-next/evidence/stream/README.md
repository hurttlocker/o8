# Streaming replay receipts

Stacked on #4410 at `87d1ee60a`. Three fresh release processes, `gpui = 0.2.2`,
1200 x 816, headless. Each selects the longest saved fixture session using the
actual production list/history GET handlers: 120 stored messages, latest 100
returned by HTTP. A separate read-only WebSocket peer replays the recorded
production wire schema against the same owned disposable data directory and
fixture Git repository. It starts no provider processes or runtime discovery.
These are authored persisted sessions, not live provider acceptance.

| Run | Changed scenes | Stream CPU scene, median ms | End key to CPU scene, median ms | Unchanged-row re-layouts |
| --- | ---: | ---: | ---: | ---: |
| 1 | 56 | 2.48 | 4.14 | 0 |
| 2 | 57 | 2.46 | 4.40 | 0 |
| 3 | 56 | 2.45 | 4.07 | 0 |
| Median of runs | | 2.46 | 4.14 | 0 |

Each run receives 60 tail revisions at a requested 20 ms cadence, plus checkpoints,
stale/late frames and one actual transport interruption. Reconnect requests a
fresh checkpoint without `since`. Queued updates may coalesce before painting;
this is why scene counts differ. All three runs reach sequence 63 and exactly the
web provider's final structured tree. None uses OS input or a visible window.

The frame timer surrounds the **first changed CPU draw**. The key timer starts
at in-process `dispatch_keystroke` before that revision's first paint and ends
after two CPU draws with a paint acknowledgement, as in #4362. Twenty End keys
keep the changing tail in view. Both timers include the pending tail's text
layout. Every timed first scene must acknowledge painting that changed tail. JSON reception/decoding and transcript merging happen before these timers.
These costs do not represent GPU execution, compositor scheduling, device input
latency, display synchronization or photon timing. No speed ratio to the spike's
2,000-turn fixture or the base's static measurements is claimed.

Completed rows keep immutable row state plus cached shaped lines, wrapping and
height. The probe requires the same `Rc` identity, nondecreasing layout counters,
and zero additional layouts for every already-laid-out unchanged row. GPUI still
positions rows and paints. Content corrections and viewport-width changes can
invalidate affected text layouts. A negative-control binary that recreated rows
failed with `unchanged row state must retain identity`; the restored binary passes.
The ordinary viewer does not clone the transcript on idle polling for this probe.

## Verification

- Locked release build and five Rust tests pass. Eight web checks pass, including
  the actual desktop socket provider configured with the dashboard merger.
- Offline Rust replay and actual CLI -> native -> HTTP/WebSocket -> paint runs
  compare against the same final web trees. Five merger cases cover advancing
  windows, optimistic entries, metadata, argument order and duplicate-id ordering.
- Replays cover empty replacement, server boot reset, stale sequences, stale
  captured snapshots, foreign sessions and reconnect. Entry retention matches the
  web store's 200-entry limit.
- Seeding an inherited token initially failed the real ws-info isolation check.
  The fixture host now overrides it with a fresh random credential before imports;
  the complete protocol run passes with the inherited token and database probes.
- The native graph audit covers 450 normal/build packages with no GPL or excluded
  application crates. Cargo audit reports zero vulnerabilities; existing
  unmaintained-dependency warnings remain. No security checks were suppressed.
- Touched-file ESLint, rule check, classification and Rust formatting pass.
- Full repository TypeScript passes, including a final check of the updated protocol runner.
- Full hermetic `npm test` passes: 1198 files and 8467 tests, with three files
  and four tests skipped; exit 0.
- A separate source review checked credential isolation, transport, merger,
  cancellation and retained-layout evidence. Execution receipts are owner-run.

Needs an unattended on-screen run: compositor cadence/content capture via the
existing `scripts/next/unattended-on-screen.swift`. It was not executed. GPU
latency and compact/wide visual acceptance remain unverified. Provider-session
measurements and full rich-content acceptance remain in #4405. Nothing is merged.

Measured binary SHA-256: `60473b09044fea720de3899117288fe717d31ef412ff7e8efd2050a81ff060b2`.
