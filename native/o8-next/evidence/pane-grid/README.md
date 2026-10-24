# Pane grid verification

The opt-in grid is built on main without importing the transcript or terminal
review branches. It uses the existing native transcript renderer and HTTP/WS
contracts. The dedicated fixture host follows `scripts/next/dev-server.ts` and
leaves that host unchanged so the other native work can merge independently.
Only discovery is injected; the fixture inventory projection, persisted runtime
transcript reader, history handlers and middleware are production code.

## Red before implementation

`tests/o8-next-pane-grid-real-path.test.ts` first ran against the existing fixture
host under its original name, `tests/next-pane-grid-real-path.test.ts`. It was
renamed to keep its generated manifest entry separate from the transcript PR.
It failed before the fixture extension and native grid were implemented:

```text
AssertionError: six persisted workers must be reachable through the production session route: expected [] to have a length of 6 but got +0
Test Files  1 failed (1)
     Tests  1 failed (1)
```

The runtime inventory assertion was added before adding its fixture support:

```text
AssertionError: runtime workers must be reachable through the production inventory route: expected 404 to be 200
Test Files  1 failed (1)
     Tests  1 failed (1)
```

`native/o8-next/tests/pane_grid_cli.rs` ran against the actual native executable
before its flag parser and root dispatch changed:

```text
test pane_grid_is_an_explicit_native_opt_in ... FAILED
assertion failed: String::from_utf8_lossy(&help.stdout).contains("--pane-grid 1|2|4|6")
test result: FAILED. 0 passed; 1 failed
```

## Green

```text
Test Files  3 passed (3)
     Tests  11 passed (11)
test result: ok. 13 passed; 0 failed; 1 ignored
test result: ok. 2 passed; 0 failed
measurement workload, each of 3 explicit release runs: 1 passed; 0 failed
npm test: Test Files  1219 passed | 3 skipped (1222)
              Tests  8651 passed | 4 skipped (8655)
```

TypeScript suites: `tests/o8-next-pane-grid-real-path.test.ts`,
`tests/next-render-parity.test.ts`, `tests/next-stream-parity.test.ts`.
Native grid regressions: `src/pane_grid_tests.rs`, `tests/pane_grid_cli.rs`.
`src/grid_sessions.rs` adds display-path matching checks. The full release Rust
suite also runs the existing transcript, stream and composer regressions.

The headless grid tests load real HTTP histories, receive six independent socket
streams, dispatch focus/size/reorder/close/choose keys, reconstruct a fresh root
from persisted workspace state, isolate another workspace in the same file and
load a runtime worker by its original key. They check bounds at 900 × 700 and
1680 × 1050 and assert that hidden/clipped transcript layout and paint counters
stop until visible. Invalid layout files are preserved by the native CLI before
it can open a window.

`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, touched TS ESLint,
`npm run rule-check -- --base=57afa2963`, test classification and Rust formatting
pass. The crate's existing license audit passes for Linux (460 normal/build
packages) and macOS (443), with zero GPL or excluded application crates. No new
dependencies or lockfile changes. Release/version/deploy/publishing files and
the shipped Tauri app are unchanged.

| Behavior | Before | After |
| --- | ---: | ---: |
| Maximum visible native session transcripts | 1 | 6 |
| Available pane counts | 1 | 1, 2, 4, 6 |
| Workspace grid persistence | 0 | size, order, sessions, focus |
| Fixture grid sessions through production HTTP | 0 | 6 |

## Measurements

Each fresh optimized process runs the actual grid root in GPUI TestAppContext,
with six 100-row persisted transcripts at 1920 × 1080. After all six sockets
deliver their initial checkpoint, the fixture pauses for two seconds. RSS is
sampled during that quiet interval with all six panes loaded and painted. The
same sockets then stream independently at 20 Hz per pane.

For each of 60 timed draws, every stream must have advanced since the previous
sample and every changed tail must acknowledge paint in that first scene. The
frame timer covers forced GPUI layout/prepaint/CPU scene paint; HTTP loading and
WS merging happen before that timer. The key timer starts before dispatching End
to the focused transcript and ends after a draw acknowledges its new revision.
Both sets use nearest-rank p95. RSS is the native test process only, excluding
the separate fixture host. These tests use GPUI's no-op text system: they do not
measure real font shaping, GPU presentation, compositor cadence or physical
input. There is no comparable six-pane baseline on main and no speedup claim.

| Release run | Six-pane frame p95 (ms) | Idle RSS, six panes (MiB) | Focused key → scene p95 (ms) |
| --- | ---: | ---: | ---: |
| 1 | 1.364 | 12.36 | 2.323 |
| 2 | 1.607 | 12.35 | 2.511 |
| 3 | 1.446 | 12.36 | 2.024 |
| Median of runs | 1.446 | 12.36 | 2.323 |

Raw samples: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json).

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml pane_grid_measurement -- --ignored --nocapture --test-threads=1
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=work/licenses-linux.json node scripts/next/license-audit.mjs
O8_NEXT_LICENSE_OUTPUT=work/licenses-macos.json node scripts/next/license-audit.mjs
```

Remaining: per-slot terminal selection/rendering alongside the separately
reviewed terminal surface, real-font/GPU/compositor measurements and unattended
on-screen visual acceptance. This slice keeps #4530 open.
