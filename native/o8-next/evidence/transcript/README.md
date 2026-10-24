# GPUI transcript pagination and rich events

The initial regression tests ran before the fix through the production HTTP
handlers and GPUI surface. Authored persisted sessions cover a 2,000-row history,
an owned OpenCode worker, packet metadata, handoff, compaction, table, diff and
image/PDF/file placeholders. No accounts, installed app, OS input or visible window
are used. Terminal and composer implementation files are unchanged.

## Behavior and parity

| Mechanic | Before | After |
| --- | ---: | ---: |
| Saved history reachable in the pagination fixture | 100 rows | 2,000 rows, 20 cursor pages |
| Runtime worker visible in native fixture sidebar | 0 | 1 beside 5 saved threads |
| Requested rich event categories in recorded native tree | 0 | 6 |
| Additional layouts for unchanged rows during the 2,000-row stream | Not measured | 0 in all 3 runs |

The rich history and tree are recorded from the production history GET and
production React renderers, then checked without updating expectations by the
native `--render-tree` entry point. The GPUI test compares that exact tree,
scrolls every rich row through paint, opens the worker using its original key,
loads earlier history and checks retained `Rc` identity and layout counters.

The WebSocket peer uses the production `history.snapshot` envelopes, including
the real 200-entry `replace: true` bootstrap checkpoint. That checkpoint initially
made older history unreachable; a second red test caught it. Overlapping
checkpoints now retain explicitly loaded earlier pages. Empty/disjoint replacement
still clears stale history. In-flight page responses are rejected after session
selection or cursor invalidation. HTTP 409 leaves the current rows readable and
offers Refresh.

Runtime inventory reads use the production route and the real owned-session
adapter over fixture metadata and JSONL. Other runtime discovery is disabled in
the disposable host. Runtime pages remain bounded by each adapter's retained
history; they cannot recover discarded provider history.

## Red and green receipts

Tests: `tests/next-history-real-path.test.ts`,
`tests/next-render-parity.test.ts`, `tests/next-stream-parity.test.ts`,
`native/o8-next/src/transcript_tests.rs` and the existing Rust suite.

Initial red tails:

```text
FAIL tests/next-history-real-path.test.ts > pages all 2,000 persisted rows without overlap through production HTTP history
AssertionError: expected undefined to match object { total: 2000, hasMore: true }
FAIL tests/next-history-real-path.test.ts > preserves every rich kind from persisted server payloads in the web oracle
Error: Outside parity scope: table-0
runtime workers must appear beside orchestrator threads
test result: FAILED. 0 passed; 1 failed
real bootstrap checkpoint must keep older-history reachable
test result: FAILED. 0 passed; 1 failed
native diff language: "DIFF"; production WebKit diff language: "diff"
test result: FAILED. 0 passed; 1 failed
```

Green tails:

```text
Test Files  3 passed (3)
     Tests  14 passed (14)
test result: ok. 11 passed; 0 failed; 1 ignored
test result: ok. 1 passed; 0 failed; 0 ignored  # each of 3 explicit benchmark runs
[o8-next] rich: 6 API messages, 6 parity rows
[o8-next] long: 100 API messages, 100 parity rows
[o8-next] tools: 8 API messages, 6 parity rows
[o8-next] review: 4 API messages, 4 parity rows
Test Files  1208 passed | 3 skipped (1211)
     Tests  8563 passed | 4 skipped (8567)
```

The ignored test is the explicit performance workload, run separately three
times in release mode. TypeScript, touched-file ESLint, Rust formatting and
the changed-file rule check pass. The full hermetic gate passes as shown above.
Its first run had one `spawnSync git ENOBUFS` failure because temporary Cargo
downloads overflowed the provenance test's Git-status buffer. Excluding the
scratch cache made that isolated suite pass 15/15, then the complete gate passed.
No release files were changed. The normal/build license audit passes for 460
Linux packages with no GPL or excluded application crates.

## Three optimized 20 Hz runs

Each run is a fresh native test process and a fresh disposable production route
host. The Surface loads all 2,000 rows through HTTP cursor pages. An actual
WebSocket connection then delivers 50 ms tail revisions through the production
subscription protocol. Each measured first CPU draw must paint the changed tail;
the first 20 updates also dispatch End and acknowledge key revision paint. Fifty
alternating scrolls measure their first changed draw. Unchanged row identity and
layout counts are checked at every stream paint. Reception and model merging
precede the frame timer, matching the existing harness's timer boundary.

**These endpoints differ.** Existing receipts use macOS headless native text
shaping on a 100-entry window (stream peer requested 20 ms cadence). New receipts
use Linux GPUI TestAppContext with its **no-op text system**, 2,000 rows and 50 ms
cadence. They measure CPU test scenes and process RSS; they establish no native
font-shaping speedup, GPU timing, compositor cadence or physical-input latency.
The existing first-content timer begins at process launch; the new timer begins
at view creation after fixture-host readiness and includes explicit first-row
paint acknowledgment. New timing therefore does not establish process-launch
latency either. Raw JSON retains the harness's `launchToFirstFrameMs` field name.

| Source / run | Stream first draw p95 ms | Scroll first draw p95 ms | End to scene p95 ms | Idle RSS MiB | First content ms (process / view) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing macOS evidence, median of 3 runs | 4.374 | 2.608 | 8.603 | 41.06 | 217.82 |
| Linux test scene 1 | 0.961 | 0.393 | 1.149 | 16.99 | 274.30 |
| Linux test scene 2 | 0.592 | 0.727 | 1.050 | 16.60 | 233.50 |
| Linux test scene 3 | 0.576 | 0.438 | 0.895 | 16.64 | 212.64 |
| Linux median of runs | 0.592 | 0.438 | 1.050 | 16.64 | 233.50 |

Nearest-rank p95 is `sorted[ceil(0.95 * sample_count) - 1]`; the summary takes
the median of each run's statistic. Existing stream/key samples come from
`../stream/run-*.json`; existing scroll/RSS/launch samples from `../run-*.json`.
New raw samples are `run-1.json`, `run-2.json`, `run-3.json`: respectively
96/96/97 changed stream scenes, 50 scrolls and 20 keys. Coalescing during initial
HTTP pagination accounts for fewer scenes than wire updates. All runs finish
with 2,000 rows and zero unchanged-row re-layouts.

Reproduce from the repository root with Node 22 and the Linux GPUI link libraries:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml
npx vitest run tests/next-history-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
O8_NEXT_BINARY="$PWD/native/o8-next/target/debug/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts --transcript --protocol-only
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml transcript_2000_rows_20hz_measurement -- --ignored --nocapture
```

The existing CLI-to-viewer offscreen benchmark was attempted after rebuilding the
CLI. Linux GPUI could not open its window: `GPUI window: neither DISPLAY nor
WAYLAND_DISPLAY is set. You can run in headless mode`. TestAppContext remains the
verified Linux rendering boundary. Real font shaping and comparable viewer
measurements, unattended on-screen/GPU acceptance, disposable provider-session
acceptance, diagrams and visualization cards remain open; this change references
#4405 rather than closing it.
