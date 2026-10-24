# Compact system events and composer (#4549)

The change addresses the transcript and composer defects on main. It does not
complete #4549: the terminal implementation is still in unmerged PR #4502, no
Linux screenshot capture entry point exists in this checkout, and the measured
grid frame p95 exceeds the requested baseline.

## Real-path regression evidence

Both tests were added before the behavior change. The composer test drives
`Composer` through GPUI input and measures the painted `composer-input` bounds.
It checks hard lines, soft wrapping, the cap, and shrinking after clearing. The
transcript test loads the authored rich session through the production HTTP
fixture host and `Surface`, inspects the retained painted text, then clicks to
expand/collapse both events. It also checks Enter/Space and narrow-window
truncation. No account, provider session, desktop app or OS input is used.

Test files:

- `native/o8-next/src/input_tests.rs`: `composer_height_bounds_follow_content`
- `native/o8-next/src/transcript_tests.rs`: `system_events_are_compact_and_expand_on_click`

| Observable | Before | After |
| --- | ---: | ---: |
| Empty composer input, including padding/border | 118 px | 38 px |
| Three hard lines | Not reached in failing test | 78 px |
| Long hard-line or soft-wrapped input | Not reached in failing test | 176 px cap |
| Default handoff text lines | 11 | 1 |
| Default handoff height | 230 px | 34 px |
| Default compaction text lines / height | Not reached in failing test | 1 / 34 px |
| Regression tests | 2 failing | 2 passing |

Full red/green tails are retained beside this file in `red-*.txt` and
`green-*.txt`. The default summaries omit field dumps; expansion preserves all
supplied fields, including nested arrays/objects and metadata. Only that list
item is invalidated when disclosure changes. Ordinary rows retain their existing
painter and cache; event eligibility is computed when row state is created.

## Frame measurements

Three sequential optimized runs per revision, using the existing ignored
`pane_grid_measurement` and `transcript_2000_rows_20hz_measurement` tests. Both
workloads run in each process with `--test-threads=1`. Baseline receipts precede
the behavior change; final receipts follow the last code change. Raw samples
are `before-1.json` through `before-3.json` and `after-1.json` through
`after-3.json` (each contains grid and transcript results).

These are Linux GPUI TestAppContext CPU scenes using its no-op text system.
They do not measure native font shaping, GPU or compositor presentation.
Nearest-rank p95 is `sorted[ceil(0.95 * n) - 1]`; the comparison uses the median
of three per-run p95 values. The grid paints six 100-row panes at 20 Hz; the
transcript loads 2,000 rows and paints the 20 Hz stream tail.

| Workload / frame p95 (ms) | Before 1 / 2 / 3 | After 1 / 2 / 3 | Median before → after | Target |
| --- | --- | --- | --- | --- |
| Grid | 0.908405 / 1.065471 / 0.841154 | 0.978100 / 0.919461 / 0.893472 | 0.908405 → 0.919461 | Unmet (+1.22%) |
| Transcript stream | 0.421634 / 0.526771 / 0.404227 | 0.389956 / 0.391939 / 0.418369 | 0.421634 → 0.391939 | Met |

Every transcript run retains 2,000 rows and records zero unchanged-row relayouts.
The grid benchmark retains the hidden/clipped-pane culling assertions. No
threshold or benchmark workload was changed.

Reproduce from the repository root with Node 22, Rust stable, dependencies and
GPUI link libraries available:

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=1
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml measurement -- --ignored --nocapture --test-threads=1
NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npm run rule-check -- --base=3660bcd4c
npm test
```

The seven touched Rust files also receive `rustfmt --check`. ESLint was invoked
on those files and reported seven ignored-file warnings, since this repository
has no Rust ESLint configuration. The rule-check script passes with zero
eligible TypeScript files. Both TypeScript commands pass with the requested
8 GiB heap; an earlier fast-check invocation without that setting exhausted
Node's default heap.

Final native suite: **20 unit tests passed, 2 measurement tests ignored**;
the separately executed measurement workloads pass in all six runs. The native
CLI tests pass **3/3**. The full `npm test` gate was run once and passes:
**1,223 files passed, 3 skipped; 8,730 tests passed, 4 skipped**.

## Remaining acceptance

- Terminal inset and cols/rows resize math: main has no native terminal module.
  The issue's terminal surface belongs to open PR #4502; this PR does not import
  its unmerged feature and dependencies.
- Before/after screenshots of all three defects: the existing capture helper,
  `scripts/next/unattended-on-screen.swift`, requires macOS. Linux TestAppContext
  paints test scenes without producing image pixels. No screenshots or visual
  acceptance are claimed.
- Grid frame p95: 0.919461 ms is above today's 0.908405 ms baseline. The transcript
  target passes; the grid target remains open despite avoiding per-row metadata
  scans and list-handle clones for ordinary rows.

Use `Refs #4549`; this evidence does not authorize closing the issue.
