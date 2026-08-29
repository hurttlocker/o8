# Terminal Workload Baseline

Phase 1 records the current hidden-terminal workload without changing terminal
delivery, attachment, parsing, or rendering behavior. The only runtime changes
are bench-gated counters and stable read-only selectors. Budgets in this report
are **PROPOSED**, not accepted gates; the operator locks them before Phase 2.

## Phase 2 status

The server hidden-view buffer and resync barrier, the client visibility and
reveal-resync protocol, the trailing-terminator resync correction, the terminal
restore-path fixes, and the fixture and screen-oracle hardening have landed.
The committed Phase 2 receipt completes all nine required samples at N=1, 4,
and 12, and every N=12 sample passes the 30-second rapid-switch proof. The
realtime-server improvement gate passes at 20.89% p50, below the strict 25%
ceiling. The input measurement completes all 27 keystrokes without a censor,
and the first-correct-frame result passes both definitions: 47.5 ms p95 after
the terminal grid matches and 364.4 ms p95 from click, including fit and resize.
Every locked row now passes, so Phase 2 is complete.

The remaining known constraints are scrollback fidelity under #1979, an
unrecoverable cursor column when the final row is non-blank, and
cursor-addressed freshness under #1981.

## Outcome

The production fixture completed nine samples: three each at 1, 4, and 12 live
terminal sessions. Each session received a deterministic 81,920-byte/second,
10-second workload with a DECSET 1049 alternate-screen phase. Each seeded
workspace restored all requested terminal chips plus exactly one Orchestrator
chip, kept the first terminal active, and exposed exactly one visible terminal
panel.

The baseline host was Darwin 25.6.0 on x64 with 16 logical CPUs and 64 GiB of
memory. CPU percentage uses process CPU-time deltas, where 100% is one logical
core. Memory is physical footprint measured after each workload.

The Phase 2 receipt used the same production fixture and host class. Its N=12
samples requested 49, 50, and 51 server benchmark snapshots respectively; the
single shared 250 ms poller keeps that observer traffic out of the old
session-count multiplier.

### Interaction and residency baseline

Values are p50 / p95 unless a range is shown.

| Sessions | Mounted terminal panels | PTYs | Attached clients/session | Hidden write B/s/panel | Hidden writes/s/panel | Long-task ms/min | Reveal ms | First-correct-frame ms | Visible input ms |
| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1 | 1 | 0 / 0 | 0 / 0 | 0 / 0 | n/a | n/a | 43.1 / 56.4 |
| 4 | 2–3 (p50 3) | 4 | 1–2 | 55,341 / 129,319 | 20.80 / 25.38 | 482 / 1,379 | 51.6 / 96.3 | 134.8 / 204.1 | 43.6 / 62.0 |
| 12 | 3 | 12 | 1–2 | 53,453 / 71,366 | 19.98 / 20.08 | 362 / 1,300 | 165.5 / 195.9 | 263.4 / 290.2 | 54.2 / 138.2 |

At 12 sessions, all three samples had exactly three mounted terminal panels and
one visible panel. Nine terminals were initially unmounted. Resident-set churn
during reveal later mounted 2–3 of those terminals, leaving 6–7 that never
mounted during the observation. The never-mounted terminals recorded zero
browser write bytes while their PTYs produced 5.1–5.9 MiB of hidden server-side
output. The session inventory endpoint reported all 12 PTYs.

### Process resource baseline

| Sessions | App server CPU % | App server MiB | Realtime server CPU % | Realtime server MiB | Browser renderer CPU % | Browser renderer MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 15.03 / 17.18 | 235 / 267 | 7.22 / 7.52 | 138 / 154 | 19.16 / 20.74 | 174 / 177 |
| 4 | 18.24 / 23.74 | 256 / 368 | 13.74 / 14.61 | 152 / 171 | 27.67 / 31.33 | 214 / 249 |
| 12 | 9.96 / 18.04 | 438 / 440 | 25.23 / 38.11 | 191 / 193 | 33.86 / 41.12 | 259 / 261 |

The app-server CPU result is not monotonic and includes dashboard restoration
and Orchestrator background work. The realtime-server and renderer trends are
the cleaner workload-scaling signals.

## Evidence

- Receipt: `tests/bench/results/terminal-workload-baseline.json`
- Phase 2 receipt: `tests/bench/results/terminal-workload-phase2.json`
- Phase 2 raw artifacts: `tests/bench/latest/terminal-workload/ticket6-full`
- Phase 2 measured commit: `e489dff0e88dda310ee47012aa421645a653c568`
- Receipt schema: `o8/terminal-workload/v1`
- Raw artifacts: `tests/bench/latest/terminal-workload-2026-08-28`
- Samples: 9, production build, fixture `terminal-ansi-alt-screen-v1`
- Measured tree base commit: `0609729bd5e286e1aa2ac33a0fde89486d0b9e6b`
- The receipt records `dirty: true` and a tree fingerprint because the fixture
  and its instrumentation had to exist before their baseline could be run.

The committed receipt is 68,622 bytes. Full per-session counters remain in the
ignored raw directory; each raw sample is below 200 KiB.

### Fixture notes

Terminal-grid setup waits are bounded at 30 seconds and excluded from every measured latency.
Visible-input polling reads 1,000 terminal lines. A timeout records whether the
marker reached the auxiliary stream, the panel write path, and a painted xterm
frame before it assigns `painted-but-missed`, `not-delivered`, or
`delivered-not-painted`.

### Attribution

These p50 totals cover one approximately 11-second observation. Write-completion
time is elapsed time from `term.write` call to its callback and therefore
includes xterm queue/parse/buffer work; it is not additive with every other
column.

| Sessions | WS JSON parse ms | Base64 decode ms | Direct `term.write` call ms | Write completion ms | xterm render events | Server fan-out deliveries |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.4 | 69.8 | 6.0 | 152.5 | 319 | 635 |
| 4 | 9.9 | 190.1 | 9.5 | 497.1 | 307 | 2,047 |
| 12 | 15.0 | 223.8 | 11.9 | 547.6 | 308 | 5,066 |

The numbers locate the hidden browser cost in base64 decode plus xterm
parse/buffer completion, not proportional painting. Direct `term.write` calls
are cheap, while callback completion is the largest measured browser-side
terminal interval. Render events stay essentially flat from 319 at one session
to 308 at twelve, even as renderer p50 CPU rises from 19.16% to 33.86% and
occasional long-task bursts appear. JSON parsing is a small fraction of the
measured terminal work.

Server fan-out is a separate scaling cost. Its p50 deliveries rise from 635 to
5,066 and realtime-server p50 CPU rises from 7.22% to 25.23%. The auxiliary
workload clients are intentional parts of the fixture, so browser attachments
plus fixture attachments produce the recorded 1–2 clients per session.

### Replay correctness evidence

The 512 KiB per-session scrollback ring overflowed even at one session: the p50
run removed 326,015 bytes. At twelve sessions the p50 run removed 3,930,373
bytes across the rings and recorded four lossy backpressure drops. The p50
alternate-screen result observed nine enter/exit phases; all nine enter markers
had aged out of retained scrollback, while exit markers remained in all twelve
rings. Replay can therefore begin after an alternate-screen enter but still
contain a later exit. Because PTY escape sequences may span the chunks trimmed
from the front of the ring, an incomplete leading escape is an additional
structural risk; the fixture directly observed the enter/exit asymmetry, not an
incomplete leading escape in these nine samples.

This favors **bounded hidden-write batching in `writeData`** for Phase 2. It can
reduce roughly 20 hidden writes per second per mounted hidden panel while
preserving the browser parser's continuous escape state. Detach-hidden plus
ring replay would save more browser work, but the measured overflow and
alternate-screen asymmetry make server-scrollback-only reconstruction unsafe
without a full terminal snapshot/recovery protocol. No intervention is included
in Phase 1.

## Locked Phase 2 budgets

The operator locked the Phase 2 thresholds after this baseline landed. The
single executable source is
`scripts/bench/terminal-workload/budgets.mjs`; `npm run bench:terminal:check`
reads the versioned receipt and fails any locked ceiling. The table below
retains the Phase 1 derivation and adds the measured Phase 2 result. The locked
gate also requires N=12 realtime-server CPU p50 to remain strictly below the
25% baseline.

| Acceptance line | Locked gate | Baseline used | Phase 2 measured | Status |
| --- | --- | --- | --- | --- |
| Hidden-session CPU | At N=12, browser-renderer p95 ≤35% and its p95 increase over N=1 ≤15 percentage points; realtime-server p95 ≤42% as a non-regression guard; main-thread long tasks p95 ≤750 ms/min. | Renderer p95 41.12%, +20.38 points over N=1; realtime p95 38.11%; long tasks p95 1,300 ms/min. | Renderer p95 26.36%, -1.39 points from N=1; realtime p50/p95 20.89%/21.36%; long tasks p95 347.25 ms/min. | Pass |
| Memory | At N=12, p95 app server ≤512 MiB, realtime server ≤224 MiB, renderer ≤288 MiB, and renderer growth over N=1 ≤112 MiB. | p95 values are 440, 193, and 261 MiB; renderer growth is 84 MiB. | p95 values are 410, 190.6, and 270 MiB; renderer growth is 68 MiB. | Pass |
| Reveal and first correct frame | Reveal p95 ≤225 ms; first-correct-frame-after-grid p95 ≤350 ms; click-to-first-correct-frame p95 including grid, fit, and resize ≤400 ms; zero correctness failures or censored timeouts. | Phase 1's old oracle recorded reveal p95 195.9 ms and first-correct-frame p95 290.2 ms without waiting for the grid. | Reveal p95 174.7 ms; grid match p95 322.9 ms; click-to-correct-frame p95 364.4 ms; after-grid p95 47.5 ms; zero correctness failures/timeouts. | Pass |
| Visible input | N=12 keystroke-to-paint p50 ≤75 ms and p95 ≤175 ms, with zero 10-second censored timeouts. | N=12 p50/p95 are 54.2/138.2 ms with zero timeouts. | p50/p95 43.6/59 ms; zero censored timeouts and therefore no timeout classes. | Pass |

For the separate “no proportional hidden rendering” acceptance line, the
locked guard is N=12 xterm render events no more than 1.25× N=1.
The baseline already meets it (308 versus 319); the CPU and long-task gates are
what prevent a no-op result from passing Phase 2.
Phase 2 also meets it at 319 versus 317, a 1.01× ratio.

On 2026-08-29, the operator authorized re-expressing first-correct-frame as two
locked rows because the Phase 1 oracle never waited for the grids to match. The
original 350 ms ceiling now applies to `firstCorrectFrameAfterGridMs`; the new
click-based `firstCorrectFrameMs`, which includes grid match, fit, and resize,
has a 400 ms ceiling based on the earlier 373.4 ms measurement.

## Residual

- This is one host and three samples per cardinality; the locked gate remains
  intentionally sensitive to a single censored sample.
- The numbers are browser production-server measurements, not packaged native
  shell measurements. The packaged footprint gate remains authoritative for
  native-process CPU and memory.
- A single measured reveal is exercised per N>1 sample. The separate N=12
  rapid-switch proof passes all three samples, but image/link/Unicode/mouse/
  paste/resize/signal behavior remains outside this receipt.
- Ring overflow and replay risk are diagnosed but not recovered in Phase 1.
- The auxiliary clients required by the workload contract contribute to server
  fan-out CPU; browser attribution is separated by process and page counters.

## Decision

Close Phase 2. The complete production receipt passes every locked CPU, memory,
latency, render-scaling, correctness, and rapid-switch row under the metric
definitions that produced their locks. Keep the packaged native footprint and
the remaining terminal behavior cases as separate follow-up coverage.
